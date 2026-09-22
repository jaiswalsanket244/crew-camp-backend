import * as dotenv from "dotenv";
import * as path from "path";
import {
  OPENSEARCH_REGION,
  ENABLE_BASELINE_METRICS,
} from "../constants/constants";

if (process.env.NODE_ENV === "test") {
  dotenv.config({ path: path.resolve(".", ".env.spec") });
} else {
  dotenv.config();
}

class Config {
  DB_PATH: string;
  PORT: string;
  CRON_PORT: string;
  HOST: string;
  FRONTEND_HOST: string;
  FRONTEND_INVITE_URL: string;
  JWT_SECRET: string;
  NODE_ENV: string;
  TWILIO_NUMBER: string;
  TWILIO_ACCOUNTSID: string;
  TWILIO_AUTHTOKEN: string;
  TWILIO_VERIFY_SERVICE_SID: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_ACCOUNT_ID: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICEID: string;
  CONTACT_FORM_TARGET: string;
  SENDGRID_API_KEY: string;
  SENDGRID_USER_EMAIL: string;
  SENDGRID_TEST_EMAIL: string;
  UPLOAD_PATH_FRONTEND_BUILD: string;
  SFTP_HOST: string;
  SFTP_PORT: string;
  SFTP_USERNAME: string;
  SFTP_PASSWORD: string;
  SSH_KEY_Path: string;
  S3_USER_KEY: string;
  S3_USER_SECRET: string;
  S3_BUCKET_NAME: string;
  S3_BUCKET_CDN: string;
  S3_BUCKET_REGION: string;
  S3_DOWNLOAD_BUCKET: string;
  SQS_URL: string;
  CDN_URL: string;
  AWS_LOG_GROUP_NAME: string;

  // OpenSearch / Search Configuration
  OPENSEARCH_ENDPOINT: string;
  OPENSEARCH_REGION: string;
  OPENSEARCH_USERNAME: string;
  OPENSEARCH_PASSWORD: string;
  OPENSEARCH_DOMAIN_NAME: string;
  SEARCH_ALARM_SNS_TOPIC_ARN: string;

  // Baseline latency metrics
  ENABLE_BASELINE_METRICS: string;

  GOOGLE_VERIFY_OAUTH_URL: string;
  FACEBOOK_VERIFY_OAUTH_URL: string;
  MICROSOFT_VERIFY_OAUTH_URL: string;
  JW_API_KEY: string;
  JW_API_SECRET: string;
  APPLE_CLIENT_ID: string;
  APPLE_CLIENT_ID_IOS: string;
  BACKUP_PATH: string;
  LOCAL_DB_FILE: string;
  SLACK_WEBHOOK_FOR_LOGS: string;
  SLACK_WEBHOOK_ADMIN_REGISTRATION: string;

  FIREBASE_API_KEY: string;
  FIREBASE_AUTH_DOMAIN: string;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_STORAGE_BUCKET: string;
  FIREBASE_MESSAGING_SENDER_ID: string;
  FIREBASE_APP_ID: string;

  GET_STREAM_MESSAGING_KEY: string;
  GET_STREAM_MESSAGING_SECRET: string;
  APP_URL: string;
  API_URL: string;
  WEB_URL: string;
  WEBHOOK_URL: string;
  REVENUECAT_API_KEY_V1: string;
  SENDGRID_PAYMENTLINk_TEMPLATE: string;
  GOOGLE_API_KEY: string;
  SALESFORCE_CLIENT_ID: string;
  SALESFORCE_CLIENT_SECRET: string;
  SALESFORCE_USERNAME: string;
  SALESFORCE_LOGIN_URL: string;
  SALESFORCE_INSTANCE_URL: string;
  ENCRYPTION_KEY: string;
  OPENAI_API_KEY: string;

  // Proline CRM — app host used to deep-link synced projects back to Proline,
  // and API host for outbound calls. Both env-overridable per environment.
  PROLINE_APP_URL: string;
  PROLINE_API_URL: string;
  // Our partner token, issued once to CrewCam by Proline. Sent as the
  // PARTNER_KEY header on every Partner API call, alongside the per-company
  // COMPANY_KEY held in each integration's credentials.
  PROLINE_PARTNER_KEY: string;

  // Cloudflare Turnstile — secret key for server-side siteverify (web CAPTCHA).
  TURNSTILE_SECRET_KEY: string;

  REDIS_URL: string;

  SENTRY_ORG_SLUG: string;
  SENTRY_PROJECT_ID: string;
  SENTRY_ORG_TOKEN: string;
  SENTRY_PROJECT_SLUG: string;

  constructor() {
    this.DB_PATH = process.env.DB_PATH;
    this.PORT = process.env.PORT;
    this.CRON_PORT = process.env.CRON_PORT;
    this.HOST = process.env.HOST;
    this.FRONTEND_HOST = process.env.FRONTEND_HOST;
    this.FRONTEND_INVITE_URL = process.env.FRONTEND_INVITE_URL;
    this.JWT_SECRET = process.env.JWT_SECRET;
    this.NODE_ENV = process.env.NODE_ENV;
    this.TWILIO_NUMBER = process.env.TWILIO_NUMBER;
    this.TWILIO_ACCOUNTSID = process.env.TWILIO_ACCOUNTSID;
    this.TWILIO_AUTHTOKEN = process.env.TWILIO_AUTHTOKEN;
    this.TWILIO_VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SERVICE_SID;
    this.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    this.STRIPE_PRICEID = process.env.STRIPE_PRICEID;
    this.STRIPE_ACCOUNT_ID = process.env.STRIPE_ACCOUNT_ID;
    this.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
    this.CONTACT_FORM_TARGET = process.env.CONTACT_FORM_TARGET;
    this.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
    this.SENDGRID_USER_EMAIL = process.env.SENDGRID_USER_EMAIL;
    this.SENDGRID_TEST_EMAIL = process.env.SENDGRID_TEST_EMAIL;
    this.UPLOAD_PATH_FRONTEND_BUILD = process.env.UPLOAD_PATH_FRONTEND_BUILD;
    this.SFTP_HOST = process.env.SFTP_HOST;
    this.SFTP_PORT = process.env.SFTP_PORT;
    this.SFTP_USERNAME = process.env.SFTP_USERNAME;
    this.SFTP_PASSWORD = process.env.SFTP_PASSWORD;
    this.SSH_KEY_Path = process.env.SSH_KEY_Path;
    this.S3_USER_KEY = process.env.S3_USER_KEY;
    this.S3_USER_SECRET = process.env.S3_USER_SECRET;
    this.S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
    this.S3_BUCKET_CDN = process.env.S3_BUCKET_CDN;
    this.S3_BUCKET_REGION = process.env.S3_BUCKET_REGION;
    this.CDN_URL = process.env.CDN_URL;
    this.SQS_URL = process.env.SQS_URL;
    this.S3_DOWNLOAD_BUCKET = process.env.S3_DOWNLOAD_BUCKET;
    this.AWS_LOG_GROUP_NAME = process.env.AWS_LOG_GROUP_NAME;

    // OpenSearch / Search Configuration
    this.OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;
    // Constant (not env) — value lives in utils/constants/constants.ts.
    this.OPENSEARCH_REGION = OPENSEARCH_REGION;
    this.OPENSEARCH_USERNAME = process.env.OPENSEARCH_USERNAME;
    this.OPENSEARCH_PASSWORD = process.env.OPENSEARCH_PASSWORD;
    this.OPENSEARCH_DOMAIN_NAME = process.env.OPENSEARCH_DOMAIN_NAME;
    this.SEARCH_ALARM_SNS_TOPIC_ARN = process.env.SEARCH_ALARM_SNS_TOPIC_ARN;

    // Baseline latency metrics — constant (not env); see constants.ts.
    this.ENABLE_BASELINE_METRICS = ENABLE_BASELINE_METRICS;

    this.GOOGLE_VERIFY_OAUTH_URL = process.env.GOOGLE_VERIFY_OAUTH_URL;
    this.FACEBOOK_VERIFY_OAUTH_URL = process.env.FACEBOOK_VERIFY_OAUTH_URL;
    this.MICROSOFT_VERIFY_OAUTH_URL = process.env.MICROSOFT_VERIFY_OAUTH_URL;
    this.JW_API_KEY = process.env.JW_API_KEY;
    this.JW_API_SECRET = process.env.JW_API_SECRET;
    this.APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;
    this.APPLE_CLIENT_ID_IOS = process.env.APPLE_CLIENT_ID_IOS;
    this.BACKUP_PATH = process.env.BACKUP_PATH;
    this.LOCAL_DB_FILE = process.env.LOCAL_DB_FILE;
    this.SLACK_WEBHOOK_FOR_LOGS = process.env.SLACK_WEBHOOK_FOR_LOGS;
    this.SLACK_WEBHOOK_ADMIN_REGISTRATION =
      process.env.SLACK_WEBHOOK_ADMIN_REGISTRATION;
    this.FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
    this.FIREBASE_AUTH_DOMAIN = process.env.FIREBASE_AUTH_DOMAIN;
    this.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
    this.FIREBASE_STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET;
    this.FIREBASE_MESSAGING_SENDER_ID =
      process.env.FIREBASE_MESSAGING_SENDER_ID;
    this.FIREBASE_APP_ID = process.env.FIREBASE_APP_ID;
    this.GET_STREAM_MESSAGING_KEY = process.env.GET_STREAM_MESSAGING_KEY;
    this.GET_STREAM_MESSAGING_SECRET = process.env.GET_STREAM_MESSAGING_SECRET;
    this.APP_URL = process.env.APP_URL;
    this.API_URL = process.env.API_URL;
    this.WEB_URL = process.env.WEB_URL;
    this.WEBHOOK_URL = process.env.WEBHOOK_URL;
    this.REVENUECAT_API_KEY_V1 = process.env.REVENUECAT_API_KEY_V1;
    this.SENDGRID_PAYMENTLINk_TEMPLATE =
      process.env.SENDGRID_PAYMENTLINk_TEMPLATE;
    this.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    this.SALESFORCE_CLIENT_ID = process.env.SALESFORCE_CLIENT_ID;
    this.SALESFORCE_CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET;
    this.SALESFORCE_USERNAME = process.env.SALESFORCE_USERNAME;
    this.SALESFORCE_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL;
    this.SALESFORCE_INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;
    this.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    this.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    this.PROLINE_APP_URL =
      process.env.PROLINE_APP_URL || "https://new.proline.app";
    this.PROLINE_API_URL =
      process.env.PROLINE_API_URL || "https://api.proline.app";
    this.PROLINE_PARTNER_KEY = process.env.PROLINE_PARTNER_KEY;
    this.TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

    // Redis Cloud Configuration
    this.REDIS_URL = process.env.REDIS_URL;

    this.SENTRY_ORG_SLUG = process.env.SENTRY_ORG_SLUG;
    this.SENTRY_PROJECT_ID = process.env.SENTRY_PROJECT_ID;
    this.SENTRY_ORG_TOKEN = process.env.SENTRY_ORG_TOKEN;
    this.SENTRY_PROJECT_SLUG = process.env.SENTRY_PROJECT_SLUG;
  }
}

export const config = new Config();
