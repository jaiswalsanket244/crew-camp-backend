# Database Configuration
DB_PATH=mongodb://localhost/test
BACKUP_PATH=xxx
LOCAL_DB_FILE=xxx

# Server Configuration
NODE_ENV=test
PORT=XXXxx
CRON_PORT=xxx
HOST=xxxx
FRONTEND_HOST= xxxx
FRONTEND_INVITE_URL= xxxx
JWT_SECRET= xxxx

# Stripe Keys
STRIPE_SECRET_KEY=XXXXXXXXXX
STRIPE_ACCOUNT_ID=xxxx
STRIPE_WEBHOOK_SECRET=xxxx

# Sendgrid Keys
SENDGRID_USER_EMAIL=XXXXXXXXXX
SENDGRID_TEST_EMAIL=xxxxxxxxxx
SENDGRID_API_KEY=XXXXXXXXXX

# Amazon S3 Keys
BUCKET_NAME=XXXXXXXXXX
S3_BUCKET_REGION=XXXXXXXXXX
S3_DOWNLOAD_BUCKET=xxxxxx
S3_BUCKET_NAME=XXXXXXXXXX
S3_BUCKET_CDN=XXXXXXXXXX
S3_USER_KEY=XXXXXXXXXX
S3_USER_SECRET=XXXXXXXXXX
AWS_LOG_GROUP_NAME=xxxxxxx
CDN_URL=xxxxxxxxxxxxxxxxxx
SQS_URL=xxxxxxxxxxxxxxxxxx

# Social Login Configuration
GOOGLE_VERIFY_OAUTH_URL=XXXXXXXX
FACEBOOK_VERIFY_OAUTH_URL=XXXXXXX
MICROSOFT_VERIFY_OAUTH_URL=XXXXXXX

# Jw Player Keys
JW_API_KEY=xxxx
JW_API_SECRET=XXXxx

# Apple Client Keys
APPLE_CLIENT_ID=xxxxxxx
APPLE_CLIENT_ID_IOS=xxxxxxxx

# Twilio Keys
TWILIO_NUMBER=xxx
TWILIO_ACCOUNTSID=xxx
TWILIO_AUTHTOKEN=xxx
TWILIO_VERIFY_SERVICE_SID=xxx

# Slack Webhooks
SLACK_WEBHOOK_FOR_LOGS=xxxxx
SLACK_WEBHOOK_ADMIN_REGISTRATION=xxxxx

# Firebase Keys
FIREBASE_API_KEY=xxxxx
FIREBASE_AUTH_DOMAIN=xxxxx
FIREBASE_PROJECT_ID=xxxxx
FIREBASE_STORAGE_BUCKET=xxxxx
FIREBASE_MESSAGING_SENDER_ID=xxxxx
FIREBASE_APP_ID=xxxxx

# Get stream keys
GET_STREAM_MESSAGING_KEY=xxxx
GET_STREAM_MESSAGING_SECRET=xxxx

# server urls
APP_URL=xxxxxxxxxx
API_URL=xxxxxxxxxx
WEB_URL=xxxxxxxxxx
WEBHOOK_URL=xxxxxxxxxxx

# config keys
REVENUECAT_API_KEY_V1=xxxxxxxxxx
SENDGRID_PAYMENTLINk_TEMPLATE=xxxxxxxxxx

#google key
GOOGLE_API_KEY=xxxxxxxx

#sales force
SALESFORCE_CLIENT_ID=xxxxxxxxxxxxxxxxx
SALESFORCE_CLIENT_SECRET=xxxxxxxxxxxxxxxx
SALESFORCE_USERNAME=xxxxxxxxxxxxxxxx
SALESFORCE_LOGIN_URL=xxxxxxxxxxxxxxxx
SALESFORCE_INSTANCE_URL=xxxxxxxxxxxxxxxx

#jobnimbus
ENCRYPTION_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# AI Walkthrough
OPENAI_API_KEY=xxxxxxxxxxxxxxxxxxxx

# Redis Cloud Configuration
REDIS_URL=redis://default:password@localhost:6379/0

# OpenSearch / Search Configuration (Story 1.2)
# (OPENSEARCH_REGION + ENABLE_BASELINE_METRICS are code constants now, not env vars.)
OPENSEARCH_ENDPOINT=http://localhost:9200
OPENSEARCH_USERNAME=test
OPENSEARCH_PASSWORD=test

# Proline CRM (both optional — code defaults to these values)
PROLINE_APP_URL=https://new.proline.app
PROLINE_API_URL=https://api.proline.app
# Partner token issued to CrewCam by Proline (required for outbound Proline API calls)
PROLINE_PARTNER_KEY=
