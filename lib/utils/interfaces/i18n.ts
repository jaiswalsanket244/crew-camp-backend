import { NotificationMessageKey } from "../enums/enums";

// Values interpolated into a notification template. Every field holds data
// (a person's name, a project name) and is never translated.
export interface NotificationMessageParams {
  actor?: string;
  project?: string;
  task?: string;
}

export type LocaleMessages = Partial<Record<NotificationMessageKey, string>>;

export interface LocalizedNotification {
  messageKey?: NotificationMessageKey;
  messageParams?: NotificationMessageParams;
  message?: string;
}
