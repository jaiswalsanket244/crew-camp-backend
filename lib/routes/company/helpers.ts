import { Company, CompanyMember, InvitedUsers } from "../../db";
import { SearchQueryWithSelectedFilters } from "../../utils/interfaces/query";
import { ObjectId } from "../../utils/helpers/commonHelper";
import {
  CURRENT_COMPANY_MEMBER_STATUS,
  CURRENT_STATUS,
  USER_ROLE,
} from "../../utils/enums/enums";
import { ICompanyMembership } from "../../utils/interfaces/companyMember";
import { Types } from "mongoose";

export class CompanyHelpers {
  public static createCompanyWithAdminUser = async (
    companyName: string,
    userId: Types.ObjectId,
    isSuperAdmin?: boolean,
  ) => {
    const company = await Company.create({
      name: companyName,
      userId: userId,
    });

    return CompanyMember.create({
      companyId: company._id,
      userId: userId,
      role: isSuperAdmin ? USER_ROLE.SUPERADMIN : USER_ROLE.ADMIN,
    });
  };

  public static addToCompany = async (
    inviteCode: string,
    userId: string | Types.ObjectId,
  ) => {
    const invite = await InvitedUsers.findById(inviteCode);

    // Reuse an existing active membership so a re-used invite link can never
    // stack duplicate rows (which would double-count the member's seat).
    const existing = await CompanyMember.findOne({
      companyId: invite.companyId,
      userId,
      status: CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
    });

    if (existing) return existing;

    return CompanyMember.create({
      companyId: invite.companyId,
      role: invite.role,
      userId,
    });
  };

  // Membership a user would land on by redeeming this invite, whatever its
  // status. Lets join/register reject a deactivated member before they create a
  // second membership that would bypass the deactivation.
  public static getMembershipByInviteCode = async (
    inviteCode: string,
    userId: string | Types.ObjectId,
  ): Promise<ICompanyMembership | null> => {
    const invite = await InvitedUsers.findById(inviteCode);

    if (!invite?.companyId) return null;

    return CompanyMember.findOne({
      companyId: invite.companyId,
      userId,
    }).lean<ICompanyMembership>();
  };

  public static getMyCompanies = async (userId: string | Types.ObjectId) => {
    return CompanyMember.find(
      { userId: userId, status: CURRENT_STATUS.ACTIVE },
      { companyId: 1, role: 1 },
    );
  };

  public static getCompanyUsers = async (
    companyIds: Types.ObjectId[],
    query: SearchQueryWithSelectedFilters,
    projectIds: Types.ObjectId[],
  ) => {
    const searchValue = query.searchValue;
    const { page, skips, pageSize } = query;

    // The team roster shows deactivated members too so an admin/manager can
    // re-enable them; they are sorted to the bottom via `isDeactivated`.
    const matchObj: any = {
      companyId: { $in: companyIds },
      status: {
        $in: [
          CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
          CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED,
        ],
      },
    };

    const postLookupMatch: any = {};

    if (query?.selectedFilters?.projects?.[0]) {
      postLookupMatch["projects.projectId"] = {
        $in: query.selectedFilters.projects.map((p) => ObjectId(p)),
      };
    }

    if (query?.selectedFilters?.userRoles?.[0]) {
      postLookupMatch["userInfo.userRole"] = {
        $in: query.selectedFilters.userRoles,
      };
    }

    if (searchValue && searchValue.length) {
      postLookupMatch.userName = {
        $regex: searchValue,
        $options: "i",
      };
    }

    const [total, items] = await Promise.all([
      CompanyMember.aggregate([
        { $match: matchObj },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            pipeline: [
              {
                $project: {
                  "name.first": 1,
                  "name.last": 1,
                  profileImage: 1,
                  userRole: 1,
                  email: 1,
                  phone: 1,
                },
              },
            ],
            as: "userInfo",
          },
        },
        {
          $addFields: {
            userName: {
              $concat: [
                { $arrayElemAt: ["$userInfo.name.first", 0] },
                " ",
                { $arrayElemAt: ["$userInfo.name.last", 0] },
              ],
            },
          },
        },
        {
          $lookup: {
            from: "projectmembers",
            let: { userId: "$userId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$userId", "$$userId"],
                  },
                  projectId: { $in: projectIds },
                  status: CURRENT_STATUS.ACTIVE,
                },
              },
            ],
            as: "projects",
          },
        },
        ...(Object.keys(postLookupMatch).length
          ? [{ $match: postLookupMatch }]
          : []),
        { $count: "total" },
      ]).then((result) => result[0]?.total || 0),

      CompanyMember.aggregate([
        { $match: matchObj },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            pipeline: [
              {
                $project: {
                  "name.first": 1,
                  "name.last": 1,
                  profileImage: 1,
                  userRole: 1,
                  email: 1,
                  phone: 1,
                },
              },
            ],
            as: "userInfo",
          },
        },
        {
          $addFields: {
            userName: {
              $concat: [
                { $arrayElemAt: ["$userInfo.name.first", 0] },
                " ",
                { $arrayElemAt: ["$userInfo.name.last", 0] },
              ],
            },
            profileImage: {
              $arrayElemAt: ["$userInfo.profileImage", 0],
            },
            userContactInfo: {
              email: {
                $arrayElemAt: ["$userInfo.email", 0],
              },
              phone: {
                $arrayElemAt: ["$userInfo.phone", 0],
              },
            },
            isDeactivated: {
              $cond: [
                {
                  $eq: ["$status", CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $lookup: {
            from: "projectmembers",
            let: { userId: "$userId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $eq: ["$userId", "$$userId"],
                  },
                  projectId: { $in: projectIds },
                  status: CURRENT_STATUS.ACTIVE,
                },
              },
            ],
            as: "projects",
          },
        },
        ...(Object.keys(postLookupMatch).length
          ? [{ $match: postLookupMatch }]
          : []),
        {
          $sort: {
            isDeactivated: 1,
            userName: 1,
          },
        },
        { $skip: skips },
        { $limit: pageSize },
        {
          $project: {
            userId: 1,
            userName: 1,
            profileImage: 1,
            role: 1,
            status: 1,
            deactivatedAt: 1,
            createdAt: 1,
            userContactInfo: 1,
            userRole: {
              $arrayElemAt: ["$userInfo.userRole", 0],
            },
            projects: "$projects.projectId",
          },
        },
      ]),
    ]);

    return [
      {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    ];
  };

  public static getCompanyUsersLight = async (
    companyIds: Types.ObjectId[],
    query: SearchQueryWithSelectedFilters,
    publicView = false,
    includeDeactivated = false,
  ) => {
    const { page, skips, pageSize, searchValue } = query;

    // Deactivated members are excluded by default — this list backs mention and
    // assignee pickers, which must only offer members who can still act.
    const matchObj: any = {
      companyId: { $in: companyIds },
      status: includeDeactivated
        ? {
            $in: [
              CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
              CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED,
            ],
          }
        : CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
    };

    const postLookupMatch: any = {};

    if (query?.selectedFilters?.userRoles?.[0]) {
      postLookupMatch["userInfo.userRole"] = {
        $in: query.selectedFilters.userRoles,
      };
    }

    if (searchValue?.length) {
      postLookupMatch.userName = { $regex: searchValue, $options: "i" };
    }

    const pipeline: any[] = [
      { $match: matchObj },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          pipeline: [
            {
              $project: {
                "name.first": 1,
                "name.last": 1,
                profileImage: 1,
                userRole: 1,
                email: 1,
                phone: 1,
                lastActivity: 1,
              },
            },
          ],
          as: "userInfo",
        },
      },
      {
        $addFields: {
          userName: {
            $concat: [
              { $arrayElemAt: ["$userInfo.name.first", 0] },
              " ",
              { $arrayElemAt: ["$userInfo.name.last", 0] },
            ],
          },
          profileImage: { $arrayElemAt: ["$userInfo.profileImage", 0] },
          userContactInfo: {
            email: { $arrayElemAt: ["$userInfo.email", 0] },
            phone: { $arrayElemAt: ["$userInfo.phone", 0] },
          },
          lastActivity: { $arrayElemAt: ["$userInfo.lastActivity", 0] },
          isDeactivated: {
            $cond: [
              { $eq: ["$status", CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED] },
              1,
              0,
            ],
          },
        },
      },
      ...(Object.keys(postLookupMatch).length
        ? [{ $match: postLookupMatch }]
        : []),
    ];

    const [total, items] = await Promise.all([
      CompanyMember.aggregate([...pipeline, { $count: "total" }]).then(
        (r) => r[0]?.total || 0,
      ),
      CompanyMember.aggregate([
        ...pipeline,
        { $sort: { isDeactivated: 1, userName: 1 } },
        { $skip: skips },
        { $limit: pageSize },
        {
          $project: publicView
            ? { _id: 0, userId: 1, userName: 1, profileImage: 1 }
            : {
                userId: 1,
                userName: 1,
                profileImage: 1,
                role: 1,
                status: 1,
                deactivatedAt: 1,
                createdAt: 1,
                userContactInfo: 1,
                userRole: { $arrayElemAt: ["$userInfo.userRole", 0] },
                lastActivity: 1,
              },
        },
      ]),
    ]);

    return [
      { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    ];
  };

  public static removeAccount = async (companyId, userId) => {
    return CompanyMember.findOneAndUpdate(
      {
        companyId,
        userId,
      },
      {
        $set: {
          status: CURRENT_STATUS.INACTIVE,
        },
      },
    );
  };

  public static getCompanyMembers = (companyIds = []) => {
    return CompanyMember.find(
      {
        companyId: { $in: companyIds },
        status: CURRENT_STATUS.ACTIVE,
      },
      { userId: 1 },
    );
  };

  public static getActiveMemberCount = (companyId: Types.ObjectId | string) => {
    return CompanyMember.countDocuments({
      companyId,
      status: CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
    });
  };

  // Membership regardless of status — needed for permission checks and to find
  // deactivated members that are being re-enabled.
  public static getMembership = (
    companyId: Types.ObjectId | string,
    userId: Types.ObjectId | string,
  ): Promise<ICompanyMembership | null> => {
    return CompanyMember.findOne({
      companyId,
      userId,
    }).lean<ICompanyMembership>();
  };

  public static deactivateMember = (
    companyId: Types.ObjectId | string,
    userId: Types.ObjectId | string,
    deactivatedBy: Types.ObjectId | string,
  ) => {
    return CompanyMember.findOneAndUpdate(
      {
        companyId,
        userId,
        status: CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
      },
      {
        $set: {
          status: CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED,
          deactivatedAt: new Date(),
          deactivatedBy,
        },
      },
      { new: true },
    );
  };

  public static reactivateMember = (
    companyId: Types.ObjectId | string,
    userId: Types.ObjectId | string,
  ) => {
    return CompanyMember.findOneAndUpdate(
      {
        companyId,
        userId,
        status: CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED,
      },
      {
        $set: { status: CURRENT_COMPANY_MEMBER_STATUS.ACTIVE },
        $unset: { deactivatedAt: "", deactivatedBy: "" },
      },
      { new: true },
    );
  };

  // Resolves whether a user is locked out: they hold no active membership but do
  // hold a deactivated one. Used by the login flows and the JWT decoder.
  public static getLockedOutMembership = async (
    userId: Types.ObjectId | string,
  ) => {
    const memberships = await CompanyMember.find(
      {
        userId,
        status: {
          $in: [
            CURRENT_COMPANY_MEMBER_STATUS.ACTIVE,
            CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED,
          ],
        },
      },
      { companyId: 1, status: 1 },
    ).lean<ICompanyMembership[]>();

    if (
      memberships.some((m) => m.status === CURRENT_COMPANY_MEMBER_STATUS.ACTIVE)
    ) {
      return null;
    }

    return (
      memberships.find(
        (m) => m.status === CURRENT_COMPANY_MEMBER_STATUS.DEACTIVATED,
      ) || null
    );
  };

  public static getCompanyAdminId = (companyId: Types.ObjectId) => {
    if (!companyId) return;
    return Company.findById(companyId, { userId: 1, name: 1, teamLimit: 1 });
  };

  public static changeAccessType = ({
    userId,
    role,
  }: {
    userId: string;
    role: string;
  }) => {
    return CompanyMember.findOneAndUpdate(
      { userId },
      {
        $set: { role },
      },
    );
  };

  public static getCompanyMemberRole = (companyId, userId) => {
    return CompanyMember.findOne(
      {
        companyId,
        userId,
        status: CURRENT_STATUS.ACTIVE,
      },
      { role: 1 },
    );
  };

  public static addUserToCompany = async (
    companyId: Types.ObjectId,
    userId: Types.ObjectId,
    role: string,
  ) => {
    return CompanyMember.create({
      companyId: companyId,
      role,
      userId,
    });
  };

  public static getCompanyById = async (companyId: Types.ObjectId) => {
    return Company.findById(companyId, { name: 1 });
  };

  public static updateTeamLimitByUserId = async (
    userId: Types.ObjectId,
    teamLimit: number,
  ) => {
    return Company.findOneAndUpdate({ userId }, { $set: { teamLimit } });
  };
}
