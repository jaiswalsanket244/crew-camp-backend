export interface NotificationChannels {
  push: boolean;
  inApp: boolean;
}

export interface NotificationTypePrefs {
  projectPosts: boolean;
  mentions: boolean;
  tasks: boolean;
  addedToProject: boolean;
}

export interface NotificationPreferences {
  channels: NotificationChannels;
  types: NotificationTypePrefs;
}

export type NotificationPreferenceTypeKey = keyof NotificationTypePrefs;

export type PartialNotificationPreferences = {
  channels?: Partial<NotificationChannels>;
  types?: Partial<NotificationTypePrefs>;
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: { push: true, inApp: true },
  types: {
    projectPosts: true,
    mentions: true,
    tasks: true,
    addedToProject: true,
  },
};
