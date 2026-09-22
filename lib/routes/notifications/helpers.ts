import { NotificationType } from "../../utils/interfaces/schemaInterface";
import { FcmTokens, Notification, Report, User } from "../../db";
import { firebaseService } from "../../services/firebaseAdmin";
import { ObjectId } from "../../utils/helpers/commonHelper";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
import { Types } from "mongoose";
import {
  NotificationCategory,
  NotificationMessageKey,
} from "../../utils/enums/enums";
import { NotificationMessageParams } from "../../utils/interfaces/i18n";
import { DEFAULT_LANGUAGE, normalizeLocale, translate } from "../../utils/i18n";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferenceTypeKey,
  NotificationPreferences,
  PartialNotificationPreferences,
} from "../../utils/interfaces/notificationPreferences";

const CATEGORY_TO_PREFKEY: Record<
  NotificationCategory,
  NotificationPreferenceTypeKey | null
> = {
  [NotificationCategory.PROJECT_POST]: "projectPosts",
  [NotificationCategory.MENTION]: "mentions",
  [NotificationCategory.TASK_ASSIGNED]: "tasks",
  [NotificationCategory.TASK_COMPLETED]: "tasks",
  [NotificationCategory.PROJECT_ADDED]: "addedToProject",
  [NotificationCategory.REPORT]: null,
  [NotificationCategory.OTHER]: null,
};

const GATEABLE_CATEGORIES = Object.entries(CATEGORY_TO_PREFKEY)
  .filter(([, prefKey]) => Boolean(prefKey))
  .map(([category]) => category as NotificationCategory);

interface RecipientContext {
  prefs: NotificationPreferences;
  language: string;
}

const cloneDefaultPreferences = (): NotificationPreferences => ({
  channels: { ...DEFAULT_NOTIFICATION_PREFERENCES.channels },
  types: { ...DEFAULT_NOTIFICATION_PREFERENCES.types },
});

export class NotificationsHelpers {
  public static getEffectivePrefs = (
    user?: {
      notificationPreferences?: Partial<NotificationPreferences>;
    } | null,
  ): NotificationPreferences => {
    const prefs = user?.notificationPreferences || {};
    return {
      channels: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.channels,
        ...(prefs.channels || {}),
      },
      types: {
        ...DEFAULT_NOTIFICATION_PREFERENCES.types,
        ...(prefs.types || {}),
      },
    };
  };

  public static getPreferences = async (userId: string) => {
    const user = await User.findById(userId, { notificationPreferences: 1 })
      .lean()
      .exec();
    return this.getEffectivePrefs(user);
  };

  private static assertValidPreferencesPayload = (
    preferences: PartialNotificationPreferences,
  ) => {
    if (
      !preferences ||
      typeof preferences !== "object" ||
      Array.isArray(preferences)
    ) {
      throw new Error("Invalid notification preferences payload");
    }

    const groups = Object.keys(preferences);
    const allowedGroups = ["channels", "types"];
    if (groups.some((key) => !allowedGroups.includes(key))) {
      throw new Error("Invalid notification preferences payload");
    }

    const channelKeys = Object.keys(preferences.channels || {});
    const allowedChannelKeys = Object.keys(
      DEFAULT_NOTIFICATION_PREFERENCES.channels,
    );
    if (channelKeys.some((key) => !allowedChannelKeys.includes(key))) {
      throw new Error("Invalid notification preferences payload");
    }

    const typeKeys = Object.keys(preferences.types || {});
    const allowedTypeKeys = Object.keys(DEFAULT_NOTIFICATION_PREFERENCES.types);
    if (typeKeys.some((key) => !allowedTypeKeys.includes(key))) {
      throw new Error("Invalid notification preferences payload");
    }

    const values = [
      ...Object.values(preferences.channels || {}),
      ...Object.values(preferences.types || {}),
    ];
    if (values.some((value) => typeof value !== "boolean")) {
      throw new Error("Invalid notification preferences payload");
    }
  };

  public static updatePreferences = async (
    userId: string,
    preferences: PartialNotificationPreferences,
  ) => {
    this.assertValidPreferencesPayload(preferences);
    const current = await this.getPreferences(userId);
    const nextPrefs: NotificationPreferences = {
      channels: {
        ...current.channels,
        ...(preferences.channels || {}),
      },
      types: {
        ...current.types,
        ...(preferences.types || {}),
      },
    };

    await User.findByIdAndUpdate(userId, {
      $set: { notificationPreferences: nextPrefs },
    }).exec();

    return nextPrefs;
  };

  private static getExcludedCategories = (
    prefs: NotificationPreferences,
  ): NotificationCategory[] => {
    if (!prefs.channels.inApp) {
      return GATEABLE_CATEGORIES;
    }

    return GATEABLE_CATEGORIES.filter((category) => {
      const prefKey = CATEGORY_TO_PREFKEY[category];
      return prefKey ? !prefs.types[prefKey] : false;
    });
  };

  private static buildVisibleCategoryMatch = (
    excludedCategories: NotificationCategory[],
  ) => {
    if (!excludedCategories.length) {
      return {};
    }

    return {
      $or: [
        { category: { $exists: false } },
        { category: { $nin: excludedCategories } },
      ],
    };
  };

  // Push bodies are rendered per recipient, so the send path needs both the
  // preferences that gate delivery and the language to render in.
  private static loadRecipientsById = async (
    notifications: NotificationType[],
  ): Promise<Record<string, RecipientContext>> => {
    const userIds = Array.from(
      new Set(
        notifications.map((notification) => notification.userId?.toString()),
      ),
    ).filter(Boolean);

    if (!userIds.length) {
      return {};
    }

    const defaults = (): RecipientContext => ({
      prefs: cloneDefaultPreferences(),
      language: DEFAULT_LANGUAGE,
    });

    try {
      const users = await User.find(
        { _id: { $in: userIds } },
        { notificationPreferences: 1, language: 1 },
      )
        .lean()
        .exec();
      return userIds.reduce<Record<string, RecipientContext>>((acc, userId) => {
        const user = users.find((u) => u._id.toString() === userId);
        acc[userId] = {
          prefs: this.getEffectivePrefs(user),
          language: normalizeLocale(user?.language),
        };
        return acc;
      }, {});
    } catch (err) {
      console.warn("[NotificationsHelpers] recipient lookup failed", err);
      return userIds.reduce<Record<string, RecipientContext>>((acc, userId) => {
        acc[userId] = defaults();
        return acc;
      }, {});
    }
  };

  public static findAll = async (
    userId: string,
    query: PaginatedSearchQuery & {
      invitations?: string;
      searchValue?: string;
    },
  ) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;

    const matchQuery: any = {
      userId: ObjectId(userId),
      projectId: { $exists: false },
    };
    const prefs = await this.getPreferences(userId);
    const visibleCategoryMatch = this.buildVisibleCategoryMatch(
      this.getExcludedCategories(prefs),
    );
    Object.assign(matchQuery, visibleCategoryMatch);

    // Stored `message` is English, so search also spans the template params
    // (actor / project / task names) which are locale-independent. Uses $and
    // because matchQuery may already carry an $or from the category filter.
    if (query.searchValue && query.searchValue != "") {
      const searchRegex = { $regex: query.searchValue, $options: "i" };
      matchQuery.$and = [
        {
          $or: [
            { message: searchRegex },
            { "messageParams.actor": searchRegex },
            { "messageParams.project": searchRegex },
            { "messageParams.task": searchRegex },
          ],
        },
      ];
    }

    if (query.invitations == "invitations") {
      matchQuery.projectId = { $exists: true };
    }

    const isInvitations = query.invitations == "invitations";

    const [total, items] = await Promise.all([
      Notification.countDocuments(matchQuery),
      Notification.aggregate([
        {
          $match: matchQuery,
        },
        {
          $sort: {
            isOpened: 1,
            createdAt: -1,
          },
        },
        { $skip: skips },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "createdBy",
            foreignField: "_id",
            pipeline: [
              {
                $project: {
                  "name.first": 1,
                  "name.last": 1,
                  profileImage: 1,
                },
              },
            ],
            as: "userInfo",
          },
        },
        ...(isInvitations
          ? []
          : [
              {
                $lookup: {
                  from: "posts",
                  localField: "postId",
                  foreignField: "_id",
                  pipeline: [
                    {
                      $project: {
                        note: 1,
                      },
                    },
                  ],
                  as: "post",
                },
              },
            ]),
        {
          $project: {
            message: 1,
            messageKey: 1,
            messageParams: 1,
            createdAt: 1,
            profileImage: {
              $arrayElemAt: ["$userInfo.profileImage", 0],
            },
            url: 1,
            postId: 1,
            taskId: 1,
            isOpened: 1,
            userName: {
              $concat: [
                { $arrayElemAt: ["$userInfo.name.first", 0] },
                " ",
                { $arrayElemAt: ["$userInfo.name.last", 0] },
              ],
            },
            ...(isInvitations
              ? {}
              : {
                  description: {
                    $arrayElemAt: ["$post.note", 0],
                  },
                  postId: 1,
                }),
          },
        },
      ]),
    ]);

    return [
      {
        items,
        total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(total / limit),
      },
    ];
  };

  public static create = async (
    userId: string,
    companyId: string,
    messageKey: NotificationMessageKey,
    createdBy?: string,
    messageParams?: NotificationMessageParams,
  ) => {
    return Notification.create({
      userId,
      companyId,
      // English copy is stored alongside the key so legacy readers of
      // `message` keep working; the read path re-renders per locale.
      message: translate(messageKey, messageParams),
      messageKey,
      messageParams,
      createdBy,
    });
  };

  private static sendNotification = async (
    userIds: Array<Types.ObjectId | string>,
    title?: string,
    message?: string,
    data?: Record<string, string>,
  ) => {
    const firebaseServiceInstance = firebaseService;

    const fcmtokens = await FcmTokens.find(
      { userId: { $in: userIds } },
      { token: 1 },
    ).lean();
    const tokens = fcmtokens.map((fcmtoken) => fcmtoken.token);

    await firebaseServiceInstance.sendPushNotifications({
      notification: {
        title: title || "",
        body: message || "",
      },
      ...(data ? { data } : {}),
      tokens,
    });
  };

  public static insertMany = async (notications: any) => {
    return Notification.insertMany(notications);
  };

  public static createAndSendNotfications = async (
    notications: NotificationType[],
    send: boolean,
    title: string,
  ) => {
    try {
      await this.insertMany(notications);
      if (send) {
        const recipientsById = await this.loadRecipientsById(notications);
        const pushNotifications = notications.filter((notification) => {
          const category = notification.category || NotificationCategory.OTHER;
          const prefKey = CATEGORY_TO_PREFKEY[category];
          const prefs =
            recipientsById[notification.userId?.toString()]?.prefs ||
            cloneDefaultPreferences();
          return prefs.channels.push && (prefKey ? prefs.types[prefKey] : true);
        });

        // One multicast per language: the body is rendered from the template,
        // so recipients on different locales cannot share a single send.
        const byLanguage = pushNotifications.reduce<
          Record<string, NotificationType[]>
        >((acc, notification) => {
          const language =
            recipientsById[notification.userId?.toString()]?.language ||
            DEFAULT_LANGUAGE;
          (acc[language] = acc[language] || []).push(notification);
          return acc;
        }, {});

        await Promise.all(
          Object.entries(byLanguage).map(([language, group]) => {
            const first = group[0];
            return this.sendNotification(
              group.map((notification) => notification.userId),
              title,
              translate(
                first?.messageKey,
                first?.messageParams,
                language,
                first?.message,
              ),
              {
                category: first?.category || NotificationCategory.OTHER,
                ...(first?.url ? { url: String(first.url) } : {}),
              },
            );
          }),
        );
      }
      return;
    } catch (er) {
      /* empty */
    }
  };

  public static findOne = async (id: string) => {
    return Notification.find({ userId: id }).lean().exec();
  };

  // set isOpened status to true
  public static findAndUpdate = async ({
    id,
    update,
  }: {
    id: string;
    update: any;
  }) => {
    return Notification.findByIdAndUpdate(id, { $set: update });
  };

  public static delete = async (_id: string, userId: string) => {
    return Notification.deleteOne({ _id, userId });
  };

  public static clearNotifications = async (userId: string) => {
    return Notification.deleteMany({ userId });
  };

  public static getUnreadCount = async (userId: string, isAdmin: boolean) => {
    const prefs = await this.getPreferences(userId);
    const visibleCategoryMatch = this.buildVisibleCategoryMatch(
      this.getExcludedCategories(prefs),
    );
    const promises: Promise<number>[] = [
      Notification.countDocuments({
        userId: ObjectId(userId),
        isOpened: false,
        projectId: { $exists: false },
        category: { $ne: NotificationCategory.REPORT },
        ...visibleCategoryMatch,
      }),
      Notification.countDocuments({
        userId: ObjectId(userId),
        isOpened: false,
        projectId: { $exists: true },
        ...visibleCategoryMatch,
      }),
    ];

    if (isAdmin) {
      promises.push(
        Report.aggregate([
          {
            $match: {
              userId: ObjectId(userId),
              isOpened: false,
            },
          },
          {
            $group: {
              _id: "$postId",
            },
          },
          {
            $count: "total",
          },
        ]).then((result) => result[0]?.total || 0),
      );
    }

    const results = await Promise.all(promises);
    const [notificationsCount, invitationsCount, reportsCount] = results;

    if (!isAdmin) {
      return {
        notificationsCount,
        invitationsCount,
      };
    }

    return {
      notificationsCount,
      invitationsCount,
      reportsCount,
    };
  };

  public static markAllAsRead = async (
    userId: string,
    isInvitations = false,
  ) => {
    const query = {
      userId: ObjectId(userId),
      isOpened: false,
      projectId: { $exists: isInvitations },
    };
    return Notification.updateMany(query, { $set: { isOpened: true } });
  };
}
