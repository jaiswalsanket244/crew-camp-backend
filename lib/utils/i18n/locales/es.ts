import { NotificationMessageKey } from "../../enums/enums";
import { LocaleMessages } from "../../interfaces/i18n";

const es: LocaleMessages = {
  [NotificationMessageKey.PROJECT_POST]: "{{actor}} publicó en {{project}}",
  [NotificationMessageKey.COMMENT_MENTION]:
    "{{actor}} te ha mencionado en un comentario.",
  [NotificationMessageKey.PROJECT_ADDED]:
    "{{actor}} te ha añadido a {{project}}",
  [NotificationMessageKey.TASK_ASSIGNED]:
    "{{actor}} te ha asignado una tarea en {{project}}",
  [NotificationMessageKey.TASK_COMPLETED]:
    "{{actor}} ha marcado la tarea como completada",
  [NotificationMessageKey.PROFILE_UPDATED]:
    "¡Tu perfil se ha actualizado correctamente!",
  [NotificationMessageKey.PASSWORD_CHANGED]:
    "Tu contraseña se ha cambiado correctamente",
  [NotificationMessageKey.TEST_NOTIFICATION]:
    "¡Hola! Esta es una notificación de prueba.",
};

export default es;
