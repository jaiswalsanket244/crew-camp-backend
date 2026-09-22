import { NotificationMessageKey, SUPPORTED_LANGUAGES } from "../enums/enums";
import {
  LocaleMessages,
  LocalizedNotification,
  NotificationMessageParams,
} from "../interfaces/i18n";
import en from "./locales/en";
import es from "./locales/es";

export const DEFAULT_LANGUAGE = "en";

const LOCALES: Record<string, LocaleMessages> = { en, es };

const isSupported = (locale?: string): boolean =>
  Boolean(locale) && SUPPORTED_LANGUAGES.includes(locale);

/**
 * Picks the locale to render in: an explicit `?lang=` override wins, then the
 * user's saved preference, then the device locale from Accept-Language, then
 * English. Only the primary subtag is considered ("es-MX" -> "es").
 */
export const resolveLocale = (req: {
  query?: { lang?: string };
  user?: { language?: string };
  headers?: { [key: string]: string | string[] | undefined };
}): string => {
  const explicit = normalize(req?.query?.lang);
  if (isSupported(explicit)) return explicit;

  const saved = normalize(req?.user?.language);
  if (isSupported(saved)) return saved;

  const header = req?.headers?.["accept-language"];
  const acceptLanguage = Array.isArray(header) ? header[0] : header;
  if (acceptLanguage) {
    const tags = acceptLanguage
      .split(",")
      .map((tag) => normalize(tag.split(";")[0]))
      .filter(Boolean);
    const match = tags.find(isSupported);
    if (match) return match;
  }

  return DEFAULT_LANGUAGE;
};

export const normalizeLocale = (locale?: string): string =>
  isSupported(normalize(locale)) ? normalize(locale) : DEFAULT_LANGUAGE;

function normalize(locale?: string): string {
  return (locale || "").trim().toLowerCase().split("-")[0];
}

/**
 * Renders a notification template in the requested locale, filling `{{param}}`
 * placeholders with untranslated data (names). Falls back to English and then
 * to the pre-rendered string stored on the notification, so legacy rows and
 * free-form messages (e.g. reported posts) keep working.
 */
export const translate = (
  key?: NotificationMessageKey,
  params?: NotificationMessageParams,
  locale?: string,
  fallback?: string,
): string => {
  if (!key) return fallback || "";

  const template = LOCALES[normalizeLocale(locale)]?.[key] || en[key];
  if (!template) return fallback || "";

  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_match, name: string) => params?.[name] ?? "",
  );
};

export const translateNotification = <T extends LocalizedNotification>(
  notification: T,
  locale?: string,
): T & { message: string } => ({
  ...notification,
  message: translate(
    notification.messageKey,
    notification.messageParams,
    locale,
    notification.message,
  ),
});
