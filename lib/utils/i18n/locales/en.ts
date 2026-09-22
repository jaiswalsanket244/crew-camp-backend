import { NotificationMessageKey } from "../../enums/enums";
import { LocaleMessages } from "../../interfaces/i18n";

const en: LocaleMessages = {
  [NotificationMessageKey.PROJECT_POST]: "{{actor}} posted in {{project}}",
  [NotificationMessageKey.COMMENT_MENTION]:
    "{{actor}} has mentioned you in a comment.",
  [NotificationMessageKey.PROJECT_ADDED]:
    "{{actor}} has added you to the {{project}}",
  [NotificationMessageKey.TASK_ASSIGNED]:
    "{{actor}} has assigned you a task in {{project}}",
  [NotificationMessageKey.TASK_COMPLETED]:
    "{{actor}} has marked the task as Completed",
  [NotificationMessageKey.PROFILE_UPDATED]:
    "Your profile has been updated successfully!",
  [NotificationMessageKey.PASSWORD_CHANGED]:
    "Your Password has been changed succesfully",
  [NotificationMessageKey.TEST_NOTIFICATION]:
    "Hi! This is a test notification!",
};

export default en;
