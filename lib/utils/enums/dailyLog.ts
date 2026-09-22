export enum DAILY_LOG_STATUS {
  ACTIVE = "active",
  DELETED = "deleted",
}

export enum DAILY_LOG_LANGUAGE {
  EN = "en",
  ES = "es",
}

export const DAILY_LOG_LANGUAGES: DAILY_LOG_LANGUAGE[] =
  Object.values(DAILY_LOG_LANGUAGE);

export const DAILY_LOG_LANGUAGE_NAME: Record<DAILY_LOG_LANGUAGE, string> = {
  [DAILY_LOG_LANGUAGE.EN]: "English",
  [DAILY_LOG_LANGUAGE.ES]: "Spanish",
};

export const toDailyLogLanguage = (value: unknown): DAILY_LOG_LANGUAGE =>
  DAILY_LOG_LANGUAGES.includes(value as DAILY_LOG_LANGUAGE)
    ? (value as DAILY_LOG_LANGUAGE)
    : DAILY_LOG_LANGUAGE.EN;

export const DAILY_LOG_SCHEMA_VERSION = 1;

export const DAILY_LOG_TITLE_MAX_LENGTH = 120;
