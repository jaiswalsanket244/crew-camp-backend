# CrewCam Backend — Architecture Document

_Comprehensive architecture reference for the crewCam-backend Node.js/Express API. Last refreshed 2026-05-13 (covers SQS download pipeline, `mapV2`, members-list, default-tag visibility, crew cleanup on user delete)._

---

## 1. System Overview

CrewCam is a field management platform for construction/field crews. This backend provides a REST API serving a React Native mobile app (iOS/Android) and a web admin panel.

**Core Capabilities:** Photo/video capture & storage, project organization, team/crew collaboration, CRM integrations (JobNimbus, CompanyCam), payments & subscriptions, real-time chat, push notifications, AI-powered walkthrough reports.

---

## 2. Technology Stack

| Category             | Technology            | Version             |
| -------------------- | --------------------- | ------------------- |
| Runtime              | Node.js               | 18                  |
| Language             | TypeScript            | ~5.2.2 (ES5 target) |
| Framework            | Express               | ^4.18.2             |
| Database             | MongoDB (Mongoose)    | ^7.6.3              |
| Auth                 | Firebase Admin        | ^11.11.0            |
| Auth (JWT)           | jsonwebtoken          | ^9.0.2              |
| Storage              | AWS S3 (SDK v3)       | ^3.433.0            |
| Queue                | AWS SQS (SDK v3)      | ^3.1030.0           |
| Payments             | Stripe                | ^14.25.0            |
| Mobile Subscriptions | RevenueCat            | API v1              |
| Chat                 | Stream Chat           | ^8.13.1             |
| Email                | SendGrid              | ^7.7.0              |
| SMS                  | Twilio                | ^4.18.1             |
| AI (LLM)             | OpenAI (GPT-4o-mini)  | ^6.27.0             |
| AI (STT)             | OpenAI Whisper        | ^6.27.0             |
| Video                | JW Player             | API                 |
| CRM                  | JobNimbus, CompanyCam | API                 |
| CRM (Leads)          | Salesforce            | jsforce             |
| Geocoding            | Google Maps           | API                 |
| Logging              | Winston + CloudWatch  | ^3.11.0             |
| Validation           | node-input-validator  | ^4.5.1              |
| Dates                | dayjs                 | ^1.11.10            |
| Testing              | Mocha + Chai + Sinon  | ^10.2.0             |
| Linting              | ESLint + Prettier     | ^8.51.0             |
| Cron                 | node-cron             | ^3.0.2              |

---

## 3. High-Level Architecture

```
                         ┌─────────────────────┐
                         │   Mobile App (RN)    │
                         │   Web Admin Panel    │
                         └─────────┬───────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
              ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
              │  /api      │ │  /v1      │ │ /webhook  │
              │ (JWT Auth) │ │ (API Key) │ │ (Raw Body)│
              └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                    │              │              │
              ┌─────▼──────────────▼──────────────▼─────┐
              │           Express Application            │
              │  (CORS, JSON parsing, compression)       │
              └─────┬──────────────┬──────────────┬─────┘
                    │              │              │
         ┌──────────▼───┐   ┌─────▼─────┐  ┌────▼────────┐
         │ 42 Feature   │   │ External  │  │ Webhook     │
         │ Route Modules│   │ API (5)   │  │ Handlers (3)│
         └──────┬───────┘   └─────┬─────┘  └────┬────────┘
                │                 │              │
         ┌──────▼─────────────────▼──────────────▼──────┐
         │              Service Layer                     │
         │  (Stripe, Firebase, S3, SQS, SendGrid,        │
         │   Twilio, OpenAI, GetStream, Geocoding,       │
         │   Encryption)                                  │
         └──────────────────┬───────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
       ┌──────▼──────┐ ┌────▼─────┐ ┌────▼────────┐
       │   MongoDB    │ │  AWS S3  │ │ AWS SQS     │
       │ (45 Models)  │ │ (objects │ │ (download   │
       │              │ │ + manifests) │ │  jobs)  │
       └─────────────┘ └──────────┘ └─────────────┘
```

---

## 4. Request Flow & Middleware Chain

### 4.1 Application Startup (`lib/index.ts`)

```
Express App Init
  → Static files (.well-known/apple-app-site-association, assetlinks.json)
  → cors()
  → express.urlencoded({ extended: true })
  → express.json({ limit: "1mb" })
  → compression()
  → Route mounting:
      /v1      → requestRateLimiter → ApiKeyMiddleware → External API routes
      /webhook → WebhookRouter (raw body — no JSON parsing)
      /api     → blockExternalApiRequests → API router
  → Global error handler (status + JSON message)
  → Catchall → serves React build index.html
```

### 4.2 API Router Middleware Chain (`lib/routes/api.ts`)

```
/api/integrations  ← Mounted BEFORE JWT (no auth required)
     ↓
middleware.jwtDecoder  ← Global JWT decoding for all subsequent routes
     ↓
/api/admin         ← adminMiddleware
/api/superAdmin    ← superAdminMiddleware
/api/auth          ← Most routes public
/api/payment       ← authMiddleware
/api/subscription  ← Mixed (success callback public, rest protected)
/api/projects      ← Mixed (details public, CRUD protected)
/api/posts         ← Mixed (read public, write protected)
/api/company       ← Mixed (most public, logo update admin-only)
... (38 more feature routers)
     ↓
ApiLogServices.apiLog     ← Request logging to CloudWatch
ErrorLogServices.errorLog ← Error logging + Slack alerts
```

### 4.3 Authentication Layers

| Layer            | Middleware              | Purpose                                           |
| ---------------- | ----------------------- | ------------------------------------------------- |
| JWT Decode       | `jwtDecoder`            | Decodes token, attaches `req.user` (non-blocking) |
| Auth Guard       | `authMiddleware`        | Blocks if no valid user on request                |
| Admin Guard      | `adminMiddleware`       | Requires `ADMIN` role                             |
| SuperAdmin Guard | `superAdminMiddleware`  | Requires `SUPER_ADMIN` role                       |
| API Key Auth     | `ApiKeyMiddleware.auth` | Validates API key for `/v1` routes                |
| Rate Limiter     | `requestRateLimiter`    | 240 req/min per client on `/v1`                   |

---

## 5. Module Architecture

### 5.1 Route Module Pattern (3-File Convention)

Every feature module in `lib/routes/{module}/` follows:

```
lib/routes/{module}/
├── index.ts    → Router class: registers routes, applies middleware
├── routes.ts   → Handler class: static methods for request/response
├── helper.ts   → Logic class: static methods for DB queries & business logic
```

**Rules:**

- All methods are `public static` arrow functions on a class
- Route handlers wrap in `try/catch` with `next(error)`
- Business logic (DB queries) lives exclusively in `helper.ts`
- Validation uses `node-input-validator` in `routes.ts`
- Responses always via `SuccessResponse()` / `ErrorResponse()`

### 5.2 Route Registration (42 Feature Routes)

| Path                  | Router                   | Auth              | Purpose                                                  |
| --------------------- | ------------------------ | ----------------- | -------------------------------------------------------- |
| `/api/integrations`   | IntegrationRouter        | None (before JWT) | CRM integrations                                         |
| `/api/admin`          | AdminRouter              | Admin             | Admin panel                                              |
| `/api/superAdmin`     | SuperAdminRouter         | SuperAdmin        | Super admin panel                                        |
| `/api/auth`           | AuthRouter               | Public            | Login, signup, OAuth, OTP, 2FA                           |
| `/api/payment`        | PaymentRouter            | Protected         | Stripe payments, cards                                   |
| `/api/subscription`   | StripeSubscriptionRouter | Mixed             | Subscriptions management                                 |
| `/api/twilio`         | TwilioRouter             | Protected         | SMS sending                                              |
| `/api/email`          | EmailRouter              | Public            | Contact form                                             |
| `/api/chat`           | ChatRouter               | Protected         | GetStream chat                                           |
| `/api/files`          | FileRouter               | Mixed             | File CRUD, presigned URLs, gallery download via SQS      |
| `/api/review`         | ReviewRouter             | Public            | Reviews                                                  |
| `/api/user`           | UserRouter               | Mixed             | Profile, password, deletion                              |
| `/api/aws`            | AwsRouter                | Public            | S3 presigned URLs                                        |
| `/api/jw-player`      | JWPlayerRouter           | Public            | Video URIs                                               |
| `/api/invite-users`   | InviteUserRouter         | Protected         | User invitations                                         |
| `/api/accept-invite`  | AcceptInviteRouter       | Public            | Accept invitations                                       |
| `/api/refund`         | RefundRouter             | Protected         | Refunds                                                  |
| `/api/fcm-token`      | FcmTokensRouter          | Protected         | Push notification tokens                                 |
| `/api/autocomplete`   | AutoCompleteRouter       | Protected         | Search autocomplete                                      |
| `/api/products`       | ProductsRouter           | Protected         | Product catalog                                          |
| `/api/orders`         | OrderRouter              | Protected         | Order management                                         |
| `/api/utils`          | UtilsRouter              | Protected         | Utility endpoints                                        |
| `/api/referrals`      | ReferralRouter           | Protected         | Referral system                                          |
| `/api/notification`   | NotificationsRouter      | Protected         | Push notifications                                       |
| `/api/projects`       | ProjectRouter            | Mixed             | Project CRUD, members                                    |
| `/api/posts`          | PostRouter               | Mixed             | Posts, photos, files                                     |
| `/api/comments`       | CommentRouter            | Mixed             | Comment threads                                          |
| `/api/projectNotes`   | ProjectNotesRouter       | Mixed             | Project notes                                            |
| `/api/projectTasks`   | ProjectTasksRouter       | Mixed             | Tasks & assignments                                      |
| `/api/tags`           | TagsRouter               | Mixed             | Tag management                                           |
| `/api/company`        | CompanyRouter            | Mixed             | Company management                                       |
| `/api/like`           | LikesRouter              | Protected         | Likes                                                    |
| `/api/reports`        | ReportsRouter            | Protected         | Content reports                                          |
| `/api/shortLink`      | ShortLinkRouter          | Public            | URL shortening                                           |
| `/api/gallery`        | GalleryRouter            | Mixed             | Photo galleries                                          |
| `/api/checklist`      | CheckListRouter          | Mixed             | Checklists & todos                                       |
| `/api/projectReports` | ProjectReportsRouter     | Mixed             | Project reports (AI/manual)                              |
| `/api/apiKeys`        | ApiKeyRouter             | Admin             | API key management                                       |
| `/api/crews`          | CrewsRouters             | Protected         | Crew management                                          |
| `/api/bin`            | BinRouter                | Protected         | Trash/restore (posts, tasks, files, checklists, reports) |
| `/api/walkthroughs`   | WalkthroughRouter        | Protected         | AI walkthrough reports                                   |

### 5.3 External API (`/v1`)

Rate-limited, API-key authenticated endpoints for third-party consumers:

| Path               | Purpose              |
| ------------------ | -------------------- |
| `/v1/projects`     | Project CRUD         |
| `/v1/posts`        | Post operations      |
| `/v1/checklist`    | Checklist operations |
| `/v1/tags`         | Tag operations       |
| `/v1/projectNotes` | Project notes        |
| `GET /v1/health`   | Health check         |

### 5.4 Async Download Pipeline (SQS)

`GET /api/files/download?galleryId=&email=` — kicks off an async ZIP download of a gallery's files:

```
Request → respond 200 immediately ("link will be shared shortly")
       → GalleryHelper.findFilesWithTheirData(galleryId)
       → Rewrite CloudFront URLs to S3 origin
       → AWSSQSService.createSingleDownloadJob(files, email)
            ├─ payload ≤ 200 KB → embed files in SQS message (useManifest: false)
            └─ payload > 200 KB → write manifest JSON to S3 (S3_DOWNLOAD_BUCKET),
                                  send one SQS message with manifestLocation
       → External worker consumes the SQS message, builds the ZIP, emails the link
```

Job IDs are Mongo `ObjectId` strings. SQS `MessageAttributes` carry `jobId`, `jobType` (`manifest`/`direct`), and batch counters for the legacy multi-message path. The legacy multi-message and file-count-batched variants (`createDownloadJob`, `createDownloadJobWithFileLimit`) remain for callers needing per-batch fan-out.

### 5.5 Webhooks (`/webhook`)

Raw body processing (no JSON middleware) for signature verification:

| Method | Path                 | Handler             | Purpose                            |
| ------ | -------------------- | ------------------- | ---------------------------------- |
| POST   | `/webhook/`          | subscriptionWebhook | RevenueCat subscription events     |
| POST   | `/webhook/stripe`    | stripeWebhook       | Stripe payment/subscription events |
| POST   | `/webhook/jobnimbus` | jobnimbusWebhook    | JobNimbus CRM sync events          |

---

## 6. Database Architecture (45 MongoDB Models)

### 6.1 Entity Relationship Overview

```
User ──────────┬──── CompanyMember ──── Company
               │         │
               │    ┌────┴────┐
               │    │         │
               ├── Project ──┼── ProjectMember
               │    │        │
               │    ├── Post (files[], tags[])
               │    ├── Comment (mentions[])
               │    ├── ProjectNote (files[])
               │    ├── ProjectTask (assignedTo[])
               │    ├── Checklist ── TodoList ── TodoListImages
               │    ├── ProjectReport ── Section ── SubSection
               │    ├── Gallery ── GalleryFiles
               │    └── File
               │
               ├── Crew ──── CrewsMember
               │         └── CrewsProject
               │
               ├── Subscription
               ├── Payment / Order / Refund
               ├── Notification
               ├── FcmToken
               ├── Referral
               └── ActivityLog
```

### 6.2 Core Models

#### User

- Fields: email, name (first/last), phone, firebaseUid, oauth[], roles, profileImage, stripe IDs, subscription fields, referral fields, company fields
- Virtuals: `fullName`, `isSuperAdmin`, `isAdmin`
- Pre-save hooks: email normalization, referral code generation
- Indexes: text (email, name.first, name.last), unique (referralCode)

#### Company

- Fields: name, userId (owner), companyLogo, status, teamLimit, `showDefaultTags` (boolean, default `true`)
- Index: userId
- `showDefaultTags` gates whether `GET /api/tags` includes the system default tag set for that company.

#### Project

- Fields: name, description, location, coordinates, companyId, status, projectImage, userId, tags[], pinnedAt, archivedAt, externalMapping (system, externalId, externalUrl, lastOutboundSync, lastSyncError)
- Indexes: companyId; unique compound (companyId + externalMapping.system + externalMapping.externalId)

#### Post

- Fields: userId, projectId, companyId, status, note, files[] (url, fileType, size, location, tags[], note, quickView, thumbnail, timestamp, annotated_by), externalCompanyCamPostId
- Indexes: (status, projectId, createdAt); (companyId, status, createdAt)

#### Comment

- Fields: userId, postId, fileId, projectId, commentId (parent), projectNoteId, status, comment, fileUrl, fileSize, mentions[]
- Index: (postId, projectId, commentId)

### 6.3 Organization Models

| Model         | Key Fields                                 | Relationships          |
| ------------- | ------------------------------------------ | ---------------------- |
| CompanyMember | companyId, userId, status, role            | Company, User          |
| ProjectMember | projectId, userId, status, type            | Project, User          |
| Crew          | name, status, companyId                    | Company                |
| CrewsMember   | crewId, userId, status                     | Crew, User             |
| CrewsProject  | crewId, projectId                          | Crew, Project          |
| InvitedUser   | companyId, projectId, userId, status, role | Company, Project, User |

### 6.4 Content Models

| Model           | Key Fields                                                           | Relationships          |
| --------------- | -------------------------------------------------------------------- | ---------------------- |
| ProjectNote     | userId, projectId, status, note, files[]                             | Project, User          |
| ProjectTask     | userId, projectId, status, name, severity, assignedTo[]              | Project, User          |
| Checklist       | userId, projectId, companyId, name, contributors[], status, type     | Project, Company       |
| TodoList        | checklistId, name, questions[], status, taskImages[], sortOrder      | Checklist              |
| TodoListImages  | checklistId, todoListId, imageData                                   | Checklist, TodoList    |
| Tags            | tag, color, type, companyId, tagFor                                  | Company                |
| Likes           | commentId/noteId, userId, isLiked                                    | Comment/Note, User     |
| Gallery         | userId                                                               | User                   |
| GalleryFiles    | userId, postId, files[], galleryId                                   | User, Post, Gallery    |
| File            | companyId, projectId, userId, name, size, fileType, url, accessLevel | Company, Project, User |
| DeletedPostFile | postId, projectId, userId, fileId, fileData, deletedAt               | Post, Project, User    |

### 6.5 Reports Models

| Model                   | Key Fields                                                                                      | Notes             |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------- |
| ProjectReport           | companyId, projectId, userId, reportName, photosPerPage, show\* flags, reportSource (AI/manual) | Parent report     |
| ProjectReportSection    | reportId, sectionName, sectionDescription, order                                                | Report sections   |
| ProjectReportSubSection | sectionId, subSectionName, image, description, order, uploadData                                | Section items     |
| Report                  | postId, userId, reason, description                                                             | Content reporting |

### 6.6 Payment & Subscription Models

| Model             | Key Fields                                                      | Notes                       |
| ----------------- | --------------------------------------------------------------- | --------------------------- |
| Payment           | type, email, chargeId, amount, status, user, currency           | Stripe payments             |
| Order             | productId, chargeId, userId, paymentStatus                      | Product orders              |
| Subscription      | userRef, planId, price, periodStarts/Ends, stripeSubscriptionId | Active subscriptions        |
| SubscriptionPlan  | title, type, currency, price, priceId, productId                | Plan catalog                |
| Product           | title, description, price, costPrice, retailPrice               | Product catalog             |
| Refund            | refundedAmount, orderRef, status, reason                        | Refund records              |
| StripePostPayment | companyId, teamLimit                                            | Post-payment team expansion |
| RevenueCatLog     | userId, event, product_id, price, type                          | Mobile IAP logs             |

### 6.7 Integration Models

| Model            | Key Fields                                                                                  | Notes                   |
| ---------------- | ------------------------------------------------------------------------------------------- | ----------------------- |
| Integration      | name, companyId, provider, credentials (encrypted), settings, webhookSecret, status         | CRM connections         |
| SyncJob          | integrationId, projectId, type, status, payload, attempts, maxAttempts, nextRetryAt, result | Async sync queue        |
| ProcessedWebhook | eventId, provider, processedAt                                                              | Idempotency (7-day TTL) |

### 6.8 System Models

| Model        | Key Fields                                                                       | Notes                  |
| ------------ | -------------------------------------------------------------------------------- | ---------------------- |
| ApiKey       | keyId (unique), keySecret (hashed), companyId, userId, name, isActive, expiresAt | External API auth      |
| Notification | userId, message, isOpened, postId, projectId, taskId                             | Push notifications     |
| FcmToken     | userId, token                                                                    | Firebase push tokens   |
| OTP          | phone, email, otp, isValid                                                       | One-time passwords     |
| Url          | url (unique)                                                                     | URL shortening         |
| ActivityLog  | userId, month, year                                                              | User activity tracking |
| Referral     | referredByRef, referredToRef, points, type                                       | Referral program       |

---

## 7. Service Layer

### 7.1 Authentication & Authorization

| Service              | File                        | Purpose                                                              |
| -------------------- | --------------------------- | -------------------------------------------------------------------- |
| FirebaseAdminService | `services/firebaseAdmin.ts` | Firebase auth (createUser, signIn, push notifications, Google OAuth) |
| SocialAuth           | `services/socialAuth.ts`    | OAuth verification (Google, Facebook, Microsoft, Apple)              |
| AccessServices       | `services/access.ts`        | Role-based access checks (isManagerOrAbove, isSelfOrManagerOrAbove)  |
| ApiKeyService        | `services/apiKeyService.ts` | API key generation (ck*\*/cs*\*), validation, hashing                |
| EncryptionService    | `services/encryption.ts`    | AES-256-GCM encryption for integration credentials                   |

### 7.2 Storage & Files

| Service       | File                    | Purpose                                                                                                                                |
| ------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| FileService   | `services/awsBucket.ts` | S3 operations (upload, delete, presigned URLs, uploadFromUrl)                                                                          |
| AWSSQSService | `services/awsSqs.ts`    | Singleton SQS client. Creates download jobs as direct messages or S3-manifest references. Chunks payloads to fit the 256 KB SQS limit. |
| FilesService  | `services/files.ts`     | File record cleanup and bin deletion                                                                                                   |
| PostService   | `services/posts.ts`     | Post cleanup, file deletion, bin management                                                                                            |

### 7.3 Payments & Subscriptions

| Service             | File                              | Purpose                                                                      |
| ------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| StripeService       | `services/stripeService.ts`       | Full Stripe integration (customers, charges, cards, subscriptions, webhooks) |
| SubscriptionService | `services/subscriptionService.ts` | Cross-provider subscription status (RevenueCat + Stripe)                     |
| RevenueCatService   | `services/revenueCatService.ts`   | Mobile IAP subscription status via RevenueCat API                            |

### 7.4 Communications

| Service              | File                    | Purpose                                                                    |
| -------------------- | ----------------------- | -------------------------------------------------------------------------- |
| SendGridService      | `services/sendgrid.ts`  | Email delivery (HTML, text, templates)                                     |
| EmailService         | `services/email.ts`     | Business email logic (password reset, OTP, subscription, invites, refunds) |
| TwilioMessageService | `services/twilio.ts`    | SMS messaging                                                              |
| GetStream            | `services/getStream.ts` | Real-time chat (client init, user management, tokens)                      |

### 7.5 AI & ML

| Service                 | File                            | Purpose                                                     |
| ----------------------- | ------------------------------- | ----------------------------------------------------------- |
| OpenAILLMService        | `services/llm/openai.ts`        | GPT-4o-mini walkthrough report generation, photo captioning |
| OpenAIWhisperSTTService | `services/stt/openaiWhisper.ts` | Audio transcription to text segments                        |

### 7.6 External APIs

| Service           | File                           | Purpose                                                   |
| ----------------- | ------------------------------ | --------------------------------------------------------- |
| GeocodingService  | `services/geocodingService.ts` | Address parsing & geocoding via Google Maps               |
| Google            | `services/google.ts`           | Reverse geocoding (coordinates → address)                 |
| SalesForceService | `services/salesforce.ts`       | Lead management (create, update, find) via OAuth JWT flow |
| HttpClient        | `services/httpClient.ts`       | Axios wrapper for external HTTP requests                  |

### 7.7 Logging & Monitoring

| Service         | File                   | Purpose                                                        |
| --------------- | ---------------------- | -------------------------------------------------------------- |
| ApiLogService   | `services/apiLog.ts`   | Request/response logging to CloudWatch (sensitive data masked) |
| ErrorLogService | `services/errorLog.ts` | Error logging to CloudWatch + Slack webhook alerts             |

---

## 8. Integration Architecture

### 8.1 Provider Pattern

```
IntegrationRoute
    → IntegrationManager (credential decryption, provider routing)
        → BaseProvider (abstract)
            ├── JobNimbusProvider (CRM sync)
            └── CompanyCamImporter (bulk data import)
```

### 8.2 CRM Integration Flow

**Inbound (CRM → CrewCam):**

```
Webhook received → Verify signature → Check idempotency
  → Parse webhook → Create SyncJob (pending)
  → Process: geocode address → create/update project → sync tags
  → On failure: retry with exponential backoff (30s, 2m, 8m, 32m, 2h)
```

**Outbound (CrewCam → CRM):**

```
Post created → onPostCreated hook
  → Check project has external mapping
  → Find active integration with outbound sync enabled
  → Create SyncJob with PhotoUploadPayload
  → Upload photo to CRM via provider
```

### 8.3 CompanyCam Import

Full data migration from CompanyCam to CrewCam:

- Users (with Firebase auth creation)
- Company setup
- Projects (with geocoding)
- Tags, Notes, Files, Posts (batched at 50)
- Checklists with images
- Project members
- Salesforce lead creation on completion

### 8.4 Sync Job Queue

| Field                  | Purpose                                           |
| ---------------------- | ------------------------------------------------- |
| type                   | `inbound_project` or `outbound_photo`             |
| status                 | `pending` → `processing` → `completed` / `failed` |
| attempts / maxAttempts | Retry tracking (max 5)                            |
| nextRetryAt            | Exponential backoff schedule                      |
| Cron                   | Every 5 minutes processes pending retry jobs      |

### 8.5 Integration Credentials

- API keys encrypted with AES-256-GCM via `EncryptionService`
- Stored as `iv:authTag:ciphertext` format
- Decrypted by `IntegrationManager` before passing to providers

---

## 9. Cron Jobs

Server: Separate process on `CRON_PORT` (default 8001).

| Schedule       | Job                                   | Purpose                                   |
| -------------- | ------------------------------------- | ----------------------------------------- |
| Daily 00:00    | `deletePostsInBin()`                  | Purge trashed posts                       |
| Daily 00:00:02 | `deleteOldGallaries()`                | Delete galleries >365 days old + S3 files |
| Daily 00:00:04 | `deleteTasksInBin()`                  | Purge trashed tasks                       |
| Daily 00:00:06 | `deleteChecklistsInBin()`             | Purge trashed checklists                  |
| Daily 00:00:08 | `deleteReportsInBin()`                | Purge trashed reports                     |
| Daily 00:00:10 | `deleteFilesInBin()`                  | Purge trashed files                       |
| Daily 00:00:12 | `permanentlyDeleteExpiredPostFiles()` | Delete expired post file records          |
| Every 5 min    | `processPendingRetryJobs()`           | Retry failed CRM sync jobs                |

Trash retention: `TRASHBIN_NO_OF_DAYS = 100 days`.

> The `backUpLocalData()` mongodump → S3 helper still lives in `cron/cronHelper.ts` but is no longer scheduled. DB backups are handled outside the app process.

---

## 10. Deployment Architecture

### 10.1 CI/CD Pipeline

```
develop branch push → GitHub Actions → ecr-staging.yml
  → Fetch secrets from Infisical (staging)
  → Build Docker image (multi-stage, node:18-alpine)
  → Push to ECR: staging/crewcam-backend:latest

main branch push → GitHub Actions → ecr-production.yml
  → Fetch secrets from Infisical (production)
  → Build Docker image
  → Push to ECR: production/crewcam-backend:latest
```

### 10.2 Docker Build (Multi-Stage)

```dockerfile
Stage 1 (base):    node:18-alpine + bash, curl, Infisical CLI
Stage 2 (deps):    npm install (production dependencies)
Stage 3 (builder): npm run tsc (TypeScript compilation)
Stage 4 (runner):  Final image with compiled server/ output
                   EXPOSE 4000, HOST 0.0.0.0
```

### 10.3 Environment Configuration

**Critical Variables (60+):**

- Database: `DB_PATH`
- Server: `PORT` (8000), `CRON_PORT` (8001), `NODE_ENV`, `JWT_SECRET`
- AWS: `S3_USER_KEY`, `S3_USER_SECRET`, `S3_BUCKET_NAME`, `S3_BUCKET_REGION`, `S3_DOWNLOAD_BUCKET`, `SQS_URL`, `CDN_URL`, `AWS_LOG_GROUP_NAME`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- Firebase: `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, etc.
- SendGrid: `SENDGRID_API_KEY`
- Twilio: `TWILIO_NUMBER`, `TWILIO_ACCOUNTSID`, `TWILIO_AUTHTOKEN`, `TWILIO_VERIFY_SERVICE_SID`
- GetStream: `GET_STREAM_MESSAGING_KEY`, `GET_STREAM_MESSAGING_SECRET`
- OpenAI: `OPENAI_API_KEY`
- Google: `GOOGLE_API_KEY`
- RevenueCat: `REVENUECAT_API_KEY_V1`
- Salesforce: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, etc.
- Integration: `ENCRYPTION_KEY`
- Monitoring: `SLACK_WEBHOOK_FOR_LOGS`

---

## 11. Subscription & Payment Architecture

### 11.1 Dual Subscription Providers

```
Mobile (iOS/Android) → RevenueCat → webhook → /webhook/ endpoint
Web                  → Stripe     → webhook → /webhook/stripe endpoint
```

### 11.2 Plan Hierarchy

| Plan       | Users  | Price ID Prefix  |
| ---------- | ------ | ---------------- |
| Basic      | 2      | basic_pp1_39     |
| Standard   | 5      | standard_pp2_89  |
| Premium    | 15     | premium_pp3_224  |
| Ultimate   | 30     | ultimate_pp4_419 |
| Enterprise | 10,000 | (custom)         |

### 11.3 Subscription Status Flow

```
NO_SUBSCRIPTION → ACTIVE → GRACE_PERIOD → EXPIRED
                     ↓
              CANCELLATION_REQUESTED
```

---

## 12. AI Features Architecture

### 12.1 Walkthrough Report Generation

```
Audio Recording (mobile)
  → Upload to S3
  → OpenAI Whisper STT → Transcript segments [{text, start, end}]
  → Match photos to transcript by timestamp
  → Detect burst photos (multiple photos per sentence)
  → OpenAI GPT-4o-mini → Structured report sections
      → Differentiate burst photo descriptions
      → Expand short clauses to full sentences
  → Create ProjectReport + Sections + SubSections in DB
```

### 12.2 Interfaces

- `ISTTService.transcribe()` — Audio buffer → transcript sentences
- `ILLMService.generateWalkthroughReport()` — Transcript + photos → structured sections
- `ILLMService.differentiatePhotoDescriptions()` — Unique captions for burst photos
- `ILLMService.expandClauses()` — Short phrases → full sentences

---

## 13. Role-Based Access Control

### 13.1 Role Hierarchy

```
SUPERADMIN (1) > ADMIN (2) > MANAGER (3) > STANDARD (4) > LIMITED (5) > GUEST
```

### 13.2 Access Matrix

| Capability         | SuperAdmin | Admin | Manager | Standard | Limited | Guest |
| ------------------ | ---------- | ----- | ------- | -------- | ------- | ----- |
| Super admin panel  | Yes        | No    | No      | No       | No      | No    |
| Admin panel        | Yes        | Yes   | No      | No       | No      | No    |
| Company management | Yes        | Yes   | No      | No       | No      | No    |
| API key management | Yes        | Yes   | No      | No       | No      | No    |
| Integration config | Yes        | Yes   | No      | No       | No      | No    |
| Project CRUD       | Yes        | Yes   | Yes     | Yes      | No      | No    |
| Post CRUD          | Yes        | Yes   | Yes     | Yes      | Yes     | No    |
| View content       | Yes        | Yes   | Yes     | Yes      | Yes     | Yes   |

---

## 14. Directory Structure (Complete — 291 TypeScript Files)

```
crewCam-backend/
├── lib/                              # TypeScript source (rootDir)
│   ├── index.ts                      # Express app entry point
│   ├── typings.d.ts                  # Global type declarations
│   │
│   ├── constants/
│   │   └── audio.ts                  # Audio size limits, MIME types
│   │
│   ├── cron/
│   │   ├── cron.ts                   # Scheduler (9 jobs)
│   │   ├── cronHelper.ts            # DB backup to S3
│   │   └── helpers/
│   │       └── gallery.ts           # Gallery cleanup (365-day TTL)
│   │
│   ├── db/                           # Mongoose schemas (50 files)
│   │   ├── index.ts                  # Barrel exports for all models
│   │   ├── user.ts                   # User accounts
│   │   ├── company.ts               # Companies
│   │   ├── companyMembers.ts        # Company membership
│   │   ├── projects.ts              # Projects
│   │   ├── projectMembers.ts        # Project membership
│   │   ├── posts.ts                 # Posts (photos/updates)
│   │   ├── comments.ts              # Comment threads
│   │   ├── projectNotes.ts          # Project notes
│   │   ├── projectTasks.ts          # Project tasks
│   │   ├── checklist.ts             # Checklists
│   │   ├── todoList.ts              # Todo items
│   │   ├── todoListImages.ts        # Todo item images
│   │   ├── tags.ts                  # Tags
│   │   ├── likes.ts                 # Likes
│   │   ├── gallery.ts               # Photo galleries
│   │   ├── galleryFiles.ts          # Gallery files
│   │   ├── files.ts                 # File metadata
│   │   ├── deletedPostFiles.ts      # Soft-deleted post files
│   │   ├── crews.ts                 # Crews
│   │   ├── crewsMembers.ts         # Crew membership
│   │   ├── crewsProjects.ts        # Crew-project assignments
│   │   ├── notifications.ts         # Notifications
│   │   ├── fcmTokens.ts            # Firebase push tokens
│   │   ├── payment.ts              # Payments
│   │   ├── orders.ts               # Orders
│   │   ├── subscription.ts         # Subscriptions
│   │   ├── subscriptionPlan.ts     # Subscription plans
│   │   ├── products.ts             # Products
│   │   ├── refund.ts               # Refunds
│   │   ├── stripePostPayment.ts    # Stripe post-payment records
│   │   ├── revenueCatLogs.ts       # RevenueCat logs
│   │   ├── projectReports.ts       # Project reports
│   │   ├── projectReportSection.ts # Report sections
│   │   ├── projectReportSubSection.ts # Report sub-sections
│   │   ├── report.ts               # Content reports
│   │   ├── activityLogs.ts         # Activity audit trail
│   │   ├── referrals.ts            # Referrals
│   │   ├── review.ts               # Reviews
│   │   ├── urls.ts                 # Short links
│   │   ├── otp.ts                  # OTP codes
│   │   ├── invitedUsers.ts         # Invited users
│   │   ├── apiKeys.ts              # API keys
│   │   ├── integration.ts          # Integration configs
│   │   ├── syncJob.ts              # Sync job queue
│   │   └── processedWebhook.ts     # Webhook idempotency (7-day TTL)
│   │
│   ├── integrations/                 # CRM integration system (12 files)
│   │   ├── index.ts                  # Module exports
│   │   ├── manager.ts               # Provider routing + credential decryption
│   │   ├── syncService.ts           # Async job queue + retry (5 attempts)
│   │   ├── webhookHelpers.ts        # Tag sync, webhook data processing
│   │   ├── hooks/
│   │   │   ├── index.ts             # Hook exports
│   │   │   ├── postHooks.ts         # onPostCreated, onFileUploaded → outbound sync
│   │   │   └── projectHooks.ts      # onProjectCreated, onProjectUpdated → CRM sync
│   │   └── providers/
│   │       ├── base.ts              # Abstract BaseProvider class
│   │       ├── jobnimbus.ts         # JobNimbus CRM provider
│   │       └── companyCam/
│   │           ├── index.ts         # CompanyCam import orchestrator
│   │           ├── client.ts        # CompanyCam API client
│   │           └── mapper.ts        # CompanyCam ↔ CrewCam data mapper
│   │
│   ├── middleware/                    # Express middleware (5 files)
│   │   ├── auth.ts                   # jwtDecoder, authMiddleware, admin, superAdmin
│   │   ├── apiKeyAuth.ts            # API key validation for /v1
│   │   ├── rateLimit.ts             # Rate limiter (240 req/min)
│   │   ├── externalApi.ts           # Block external API hosts
│   │   └── upload.ts                # Audio upload (multer, 100MB limit)
│   │
│   ├── routes/                       # Feature route modules (138 files)
│   │   ├── api.ts                    # Main API router (42 feature mounts)
│   │   │
│   │   ├── auth/                     # Authentication (16 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── user/                     # User profile (7 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── company/                  # Company management (9 endpoints, incl. members-list, show-default-tags)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── projects/                 # Project CRUD (19 endpoints, incl. /mapV2)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── posts/                    # Photo/post management (17 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── comments/                 # Comment threads (4 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── projectNotes/             # Project notes (4 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── projectTasks/             # Tasks & assignments (5 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── checklist/                # Checklists & todos (11 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── tags/                     # Tag management (5 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── likes/                    # Likes (1 endpoint)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── gallery/                  # Photo galleries (2 endpoints)
│   │   │   ├── index.ts / router.ts / helper.ts
│   │   ├── crews/                    # Crew management (9 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── file/                     # File operations (9 endpoints, incl. /download via SQS)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── aws/                      # S3 presigned URLs (2 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── payment/                  # Stripe payments (13 endpoints)
│   │   │   ├── index.ts / routes.ts
│   │   │   └── helpers/user.helper.ts
│   │   ├── subscription/             # Subscription management (11 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── integrations/             # CRM integrations (10 endpoints)
│   │   │   ├── index.ts / routes.ts / helper.ts
│   │   ├── notifications/            # Push notifications (9 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── fcmTokens/               # Firebase tokens (6 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── chat/                     # GetStream chat (2 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── email/                    # Contact form (1 endpoint)
│   │   │   ├── index.ts / routes.ts
│   │   ├── twilio/                   # SMS (1 endpoint)
│   │   │   ├── index.ts / routes.ts
│   │   ├── inviteUser/               # User invitations (1 endpoint)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── orders/                   # Order management (5 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── products/                 # Product catalog (5 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── refunds/                  # Refunds (2 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── referrals/                # Referral system (1 endpoint)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── reports/                  # Content reports (6 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── projectReport/            # Project reports (5 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── review/                   # Reviews (1 endpoint)
│   │   │   ├── index.ts / routes.ts
│   │   ├── shortLink/                # URL shortening (1 endpoint)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── autoComplete/             # Search autocomplete (1 endpoint)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── apiKeys/                  # API key management (4 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── jwPlayer/                 # Video URIs (2 endpoints)
│   │   │   ├── index.ts / routes.ts
│   │   ├── utils/                    # Utility endpoints (3 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   ├── bin/                      # Trash/restore (17 endpoints)
│   │   │   ├── index.ts / routes.ts
│   │   ├── walkthrough/              # AI walkthrough reports (2 endpoints)
│   │   │   ├── index.ts / routes.ts / helpers.ts
│   │   │
│   │   ├── admin/                    # Admin panel (22 files)
│   │   │   ├── admin.ts              # Admin router (mounts sub-routers)
│   │   │   ├── users/                # index.ts / routes.ts / helpers.ts
│   │   │   ├── invitedUsers/         # index.ts / routes.ts / helpers.ts
│   │   │   ├── payments/             # index.ts / routes.ts / helpers.ts
│   │   │   ├── products/             # index.ts / routes.ts / helpers.ts
│   │   │   ├── refund/               # index.ts / routes.ts / helpers.ts
│   │   │   ├── subscription/         # index.ts / routes.ts / helpers.ts
│   │   │   └── company/              # index.ts / routes.ts / helpers.ts
│   │   │
│   │   ├── superAdmin/               # Super admin panel (22 files)
│   │   │   ├── index.ts              # SuperAdmin router
│   │   │   ├── users/                # index.ts / routes.ts / helpers.ts
│   │   │   ├── subscriptions/        # index.ts / routes.ts / helpers.ts
│   │   │   ├── projects/             # index.ts / routes.ts / helpers.ts
│   │   │   ├── products/             # index.ts / routes.ts / helpers.ts
│   │   │   ├── referrals/            # index.ts / routes.ts / helpers.ts
│   │   │   └── stripePayment/        # index.ts / routes.ts / helpers.ts
│   │   │
│   │   ├── external/v1/              # External API (API key auth)
│   │   │   ├── index.ts              # V1 router + health check
│   │   │   ├── Projects/index.ts     # External project routes
│   │   │   ├── posts/index.ts        # External post routes
│   │   │   ├── checklists/index.ts   # External checklist routes
│   │   │   ├── tags/index.ts         # External tag routes
│   │   │   └── projectNotes/index.ts # External notes routes
│   │   │
│   │   └── webhooks/                 # Webhook handlers
│   │       ├── index.ts              # WebhookRouter (3 routes)
│   │       └── routes.ts             # Webhook handler implementations
│   │
│   ├── services/                     # Shared services (32 files)
│   │   ├── connectDB.ts              # MongoDB connection
│   │   ├── awsBucket.ts              # AWS S3 operations
│   │   ├── awsSqs.ts                 # AWS SQS singleton (async download jobs, S3 manifest fallback)
│   │   ├── stripeService.ts          # Stripe payments & subscriptions
│   │   ├── firebaseAdmin.ts          # Firebase auth + push notifications
│   │   ├── sendgrid.ts               # SendGrid email delivery
│   │   ├── email.ts                  # Business email logic
│   │   ├── twilio.ts                 # Twilio SMS
│   │   ├── getStream.ts              # Stream Chat messaging
│   │   ├── encryption.ts             # AES-256-GCM encryption
│   │   ├── geocodingService.ts       # Google Maps geocoding
│   │   ├── google.ts                 # Reverse geocoding
│   │   ├── subscriptionService.ts    # Cross-provider subscription checks
│   │   ├── revenueCatService.ts      # RevenueCat mobile IAP
│   │   ├── salesforce.ts             # Salesforce CRM leads
│   │   ├── socialAuth.ts             # OAuth providers (Google/FB/MS/Apple)
│   │   ├── apiKeyService.ts          # API key generation & validation
│   │   ├── httpClient.ts             # Axios HTTP wrapper
│   │   ├── multerConfig.ts           # File upload config (5MB images)
│   │   ├── access.ts                 # Role-based access helpers
│   │   ├── posts.ts                  # Post cleanup & bin deletion
│   │   ├── files.ts                  # File cleanup & bin deletion
│   │   ├── checklists.ts             # Checklist cleanup
│   │   ├── tasks.ts                  # Task cleanup
│   │   ├── projectReport.ts          # Report cleanup
│   │   ├── apiLog.ts                 # CloudWatch request logging
│   │   ├── errorLog.ts               # Error logging + Slack alerts
│   │   ├── logHelpers.ts             # Sensitive data masking
│   │   ├── llm/
│   │   │   ├── index.ts              # LLM service facade
│   │   │   └── openai.ts             # GPT-4o-mini walkthrough reports
│   │   └── stt/
│   │       ├── index.ts              # STT service facade
│   │       └── openaiWhisper.ts      # Whisper audio transcription
│   │
│   └── utils/                        # Utilities (28 files)
│       ├── configuration/
│       │   └── config.ts             # 60+ env vars (singleton)
│       ├── constants/
│       │   └── constants.ts          # Plan limits, file limits, pricing
│       ├── helpers/
│       │   ├── apiResponse.ts        # SuccessResponse / ErrorResponse
│       │   ├── commonHelper.ts       # ObjectId, JWT, pagination, dates, pipelines
│       │   └── users.ts             # Role hierarchy helpers
│       ├── enums/
│       │   ├── enums.ts              # Status, roles, subscriptions, payments, tags
│       │   ├── checklist.ts          # Checklist status/type
│       │   ├── files.ts              # File access types
│       │   ├── post.ts               # Sort types
│       │   ├── projectDetailTab.ts   # UI tab enums
│       │   ├── projectReports.ts     # Report status/source
│       │   ├── salesforce.ts         # Lead source
│       │   ├── tasks.ts              # Task management types
│       │   └── integrations/
│       │       ├── index.ts          # INTEGRATION_PROVIDERS, INTEGRATION_STATUS
│       │       └── companyCam.ts     # CompanyCam roles, answer types
│       └── interfaces/
│           ├── apiResponse.ts        # ApiResponseType
│           ├── authenticated-request.ts # AuthenticatedRequest extends Express.Request
│           ├── files.ts              # IFileCreate, IPreSignedUrlPayload, etc.
│           ├── gallery.ts            # IGalleryFiles, CreateGalleryRequestBody
│           ├── httpClientConfig.ts   # httpClientConfig type
│           ├── location.ts           # ICoordinates
│           ├── post.ts               # PostType, FileType, IReplaceOriginalFile
│           ├── project.ts            # ICompanyProjects
│           ├── projectReports.ts     # IPreReportData, IReportResponse, etc.
│           ├── projectTasks.ts       # IProjectTasksFindAll
│           ├── query.ts              # PaginatedSearchQuery, MyUploadsQuery
│           ├── saleForcesServices.ts # ICreateLead
│           ├── schemaInterface.ts    # All domain types (User, Company, Comment, etc.)
│           ├── subscription.ts       # SubscriptionStatusType
│           ├── walkthrough.ts        # ITranscriptSentence, ISTTService, ILLMService
│           └── integrations/
│               ├── index.ts          # IIntegration, IntegrationProvider
│               ├── types.ts          # ExternalProject, PhotoUploadPayload, etc.
│               └── companyCam.ts     # CompanyCam API types (50+ interfaces)
│
├── server/                           # Compiled JS output (outDir) — DO NOT EDIT
├── .github/workflows/
│   ├── ecr-production.yml            # Deploy main → ECR production
│   └── ecr-staging.yml              # Deploy develop → ECR staging
├── Dockerfile                        # Multi-stage Node 18 alpine build
├── package.json                      # Node 18, 40+ dependencies
├── tsconfig.json                     # ES5 target, lib/ → server/
├── .eslintrc.json                    # ESLint + @typescript-eslint/recommended
├── .prettierrc                       # semi: true
└── .env.example                      # 60+ environment variables
```

---

## 15. API Response Format

All endpoints return a standardized JSON structure:

```json
{
  "success": true | false,
  "message": "Human-readable message",
  "data": { ... },
  "errors": { ... }
}
```

Generated by `SuccessResponse(res, statusCode, { message, data })` and `ErrorResponse(res, statusCode, { message, errors })` from `lib/utils/helpers/apiResponse.ts`.

---

## 16. Key Architectural Decisions

1. **Firebase for Auth**: Firebase Admin SDK handles user creation, token verification, and push notifications. JWT tokens are generated server-side for API auth.

2. **Dual AWS SDK**: Both aws-sdk v2 and @aws-sdk/client-s3 v3 coexist. v3 is used for newer S3 operations (presigned URLs), v2 for legacy code.

3. **Provider Pattern for CRM**: Extensible integration architecture via `BaseProvider` abstract class. New CRMs implement the interface without modifying core code.

4. **Async Sync Queue**: CRM operations are queued as SyncJobs with retry logic, preventing webhook/post creation failures from blocking core operations.

5. **Encrypted Credentials**: Integration API keys stored encrypted (AES-256-GCM). Decrypted at runtime by IntegrationManager.

6. **Separate Cron Process**: Cron jobs run on a dedicated port/process to avoid blocking the main API server.

7. **Soft Delete + Bin**: Content is soft-deleted (status: DELETED), moved to bin, and permanently purged after 100 days by cron.

8. **Cross-Provider Subscriptions**: SubscriptionService checks both RevenueCat (mobile) and Stripe (web) for active subscription status.

9. **Static Class Methods**: All route handlers and helpers use static methods on classes rather than standalone functions, maintaining consistent patterns.

10. **Text Indexes for Search**: User, Payment, and OTP models use MongoDB text indexes for full-text search capabilities.

11. **SQS for Heavy Downloads**: Gallery ZIP downloads run out-of-band via SQS. The API responds 200 immediately, then enqueues either a direct message (≤200 KB) or an S3-manifest reference (`S3_DOWNLOAD_BUCKET/download-manifests/{jobId}.json`) so an external worker can produce the ZIP and email the link without blocking the request thread.

12. **`companyId` on Posts is Load-Bearing**: Grid-view and timeline queries match on `Posts.companyId` directly (indexed) rather than `$in: projectIds`. Any code path that creates posts (including file moves via `moveFilesToProject`) must populate `companyId` or those posts will be invisible to grid/timeline reads.

13. **Default-Tag Visibility Per Company**: `Company.showDefaultTags` controls whether `GET /api/tags` returns the system default tag list for that company. Custom tags are always returned; defaults are conditional.
