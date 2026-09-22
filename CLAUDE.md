# CrewCam Backend - CLAUDE.md

## Quick Reference

- **Stack**: Node.js + Express + TypeScript + MongoDB (Mongoose)
- **Entry point**: `lib/index.ts`
- **Build output**: `server/`
- **Dev server**: `npm run server` (nodemon)
- **Production**: `npm run production`
- **TypeScript check**: `tsc --noEmit`
- **Lint**: `npm run lint`
- **Format**: `npm run format`
- **Cron server**: `npm run cron-server` (separate port via `CRON_PORT`)

---

## Rules

### 1. No `any` Type
- Never use `any`. Always create proper interfaces/types in `lib/utils/interfaces/`.

### 2. No Production Database Modifications Without Approval
- Never run migrations, bulk updates, or data modifications against production without explicit user confirmation.
- Always check which `DB_PATH` is active in `.env`, tell the user which DB it targets, and ask for approval.
- Default to suggesting staging first.

### 3. Validators Required
- Every endpoint must have a validator for the necessary data to fulfill the request.

### 4. Follow Naming Conventions
- Always follow the existing file/folder naming conventions in the codebase. Check neighboring files before creating new ones.

### 5. Error Checking
- After making changes, **always run `tsc --noEmit`** to verify no type errors were introduced.
- Ignore pre-existing errors unrelated to the current changes.

### 6. Comments
- Add **brief comments only on complex functions** — don't over-comment simple/obvious code.

### 7. Planning Before Heavy Changes
- Before starting significant/heavy changes, **think of multiple optimized approaches** and present them to the user for selection before implementing.

---

## Architecture

### Request Flow

```
Client Request
  → Express App (lib/index.ts)
    → /v1      → Rate Limiter → API Key Auth → External API Routes
    → /webhook → Stripe / JobNimbus / Subscription handlers
    → /api     → JWT Decoder → Auth Middleware → Role Middleware → Route Handler
```

### Module Pattern

Every feature module follows this structure:

```
lib/routes/{module}/
├── index.ts      → Class with express.Router(), registers routes from routes.ts
├── routes.ts     → Static methods: request handling, validation, calls helpers
├── helpers.ts    → MongoDB queries and business logic
```

Routes handle request/response logic. Helpers handle database operations. Index wires them together.

### Route Registration

1. `lib/index.ts` mounts top-level routers:
   - `/v1` → `lib/routes/external/v1/index.ts`
   - `/webhook` → `lib/routes/webhooks/index.ts`
   - `/api` → `lib/routes/api.ts`

2. `lib/routes/api.ts` mounts all feature modules under `/api` with middleware chain:
   - Integration routes (no auth)
   - JWT decoder middleware
   - 40+ feature routers
   - Admin routes (admin middleware)
   - Super admin routes (super admin middleware)
   - API logging

### Response Format

All endpoints use helpers from `lib/utils/helpers/apiResponse.ts`:
```typescript
SuccessResponse(res, statusCode, { message, data })
ErrorResponse(res, statusCode, { message })
```

---

## Directory Map

### `lib/db/` — Mongoose Schemas

| File | Schema |
|------|--------|
| user.ts | User accounts |
| company.ts | Companies |
| companyMembers.ts | Company membership |
| crews.ts, crewsMembers.ts, crewsProjects.ts | Crew management |
| projects.ts, projectMembers.ts | Projects |
| projectTasks.ts | Project tasks/checklists |
| projectNotes.ts | Project notes |
| posts.ts | Posts (photos/updates) |
| comments.ts | Comment threads |
| files.ts, deletedPostFiles.ts | File metadata |
| gallery.ts, galleryFiles.ts | Photo galleries |
| checklist.ts | Checklists |
| todoList.ts, todoListImages.ts | Todo items |
| payment.ts, orders.ts | Payments & orders |
| subscription.ts, subscriptionPlan.ts | Subscriptions |
| products.ts | Products |
| refund.ts | Refunds |
| stripePostPayment.ts | Stripe post-payment records |
| revenueCatLogs.ts | RevenueCat logs |
| report.ts | Reports |
| projectReports.ts, projectReportSection.ts, projectReportSubSection.ts | Project reports |
| activityLogs.ts | Activity audit trail |
| likes.ts | Likes |
| tags.ts | Tags |
| notifications.ts | Notifications |
| referrals.ts | Referrals |
| review.ts | Reviews |
| urls.ts | Short links |
| apiKeys.ts | API keys |
| integration.ts, syncJob.ts, processedWebhook.ts | Integration state |
| invitedUsers.ts | Invited users |
| otp.ts | OTP codes |
| fcmTokens.ts | Firebase push tokens |

All models exported from `lib/db/index.ts`.

### `lib/routes/` — Feature Modules

| Route Path | Module | Purpose |
|------------|--------|---------|
| /api/auth | auth/ | Login, signup, OAuth |
| /api/user | user/ | User profile CRUD |
| /api/company | company/ | Company management |
| /api/projects | projects/ | Project CRUD, members |
| /api/posts | posts/ | Post creation/management |
| /api/comments | comments/ | Comment threads |
| /api/likes | likes/ | Like functionality |
| /api/tags | tags/ | Tag management |
| /api/checklist | checklist/ | Checklist items |
| /api/project-tasks | projectTasks/ | Project tasks |
| /api/project-notes | projectNotes/ | Project notes |
| /api/project-report | projectReport/ | Project reports |
| /api/gallery | gallery/ | Photo gallery |
| /api/crews | crews/ | Crew management |
| /api/notifications | notifications/ | Notifications |
| /api/file | file/ | File operations |
| /api/aws | aws/ | S3 presigned URLs |
| /api/chat | chat/ | GetStream chat |
| /api/payment | payment/ | Payments |
| /api/subscription | subscription/ | Stripe subscriptions |
| /api/orders | orders/ | Order management |
| /api/products | products/ | Product catalog |
| /api/refunds | refunds/ | Refund management |
| /api/reports | reports/ | Report generation |
| /api/fcm-tokens | fcmTokens/ | Firebase push tokens |
| /api/invite-user | inviteUser/ | User invitations |
| /api/referrals | referrals/ | Referral system |
| /api/short-link | shortLink/ | URL shortening |
| /api/auto-complete | autoComplete/ | Search autocomplete |
| /api/api-keys | apiKeys/ | API key management |
| /api/bin | bin/ | Trash/deleted items |
| /api/utils | utils/ | Utility endpoints |
| /api/integrations | integrations/ | CompanyCam, JobNimbus |
| /api/admin/* | admin/ | Admin panel (nested) |
| /api/super-admin/* | superAdmin/ | Super admin (nested) |
| /v1/* | external/v1/ | External API (API key auth) |
| /webhook/* | webhooks/ | Stripe, JobNimbus webhooks |

### `lib/services/` — Shared Services

| Service | Purpose |
|---------|---------|
| connectDB.ts | MongoDB connection |
| awsBucket.ts | AWS S3 operations (upload, presigned URLs) |
| stripeService.ts | Stripe payment processing |
| subscriptionService.ts | Subscription logic |
| revenueCatService.ts | Mobile subscription (RevenueCat) |
| firebaseAdmin.ts | Firebase push notifications |
| email.ts, sendgrid.ts | Email via SendGrid |
| twilio.ts | SMS via Twilio |
| getStream.ts | Chat via GetStream |
| encryption.ts | Data encryption/decryption |
| geocodingService.ts | Geolocation/geocoding |
| google.ts | Google OAuth |
| socialAuth.ts | Social login providers |
| salesforce.ts | Salesforce CRM sync |
| httpClient.ts | HTTP request utility |
| files.ts | File management |
| posts.ts | Post service logic |
| tasks.ts | Task management |
| checklists.ts | Checklist logic |
| projectReport.ts | Report generation |
| multerConfig.ts | File upload config |
| apiLog.ts | API request logging |
| errorLog.ts | Error logging |
| logHelpers.ts | Logging utilities |
| apiKeyService.ts | API key validation |

### `lib/middleware/` — Middleware

| File | Exports | Purpose |
|------|---------|---------|
| auth.ts | jwtDecoder, authMiddleware, superAdminMiddleware, adminMiddleware, adminOrModeratorMiddleware | JWT verification & role-based access |
| apiKeyAuth.ts | ApiKeyMiddleware | External API key validation |
| externalApi.ts | blockExternalApiRequests | Blocks /api from external domains |
| rateLimit.ts | rateLimiter | Request rate limiting |

### `lib/utils/` — Utilities

| Path | Purpose |
|------|---------|
| configuration/config.ts | Environment config (60+ vars) |
| constants/constants.ts | App constants |
| helpers/apiResponse.ts | SuccessResponse / ErrorResponse |
| helpers/commonHelper.ts | Shared utility functions |
| helpers/users.ts | User-related utilities |
| enums/enums.ts | Roles, statuses |
| enums/files.ts | File types |
| enums/checklist.ts | Checklist statuses |
| enums/post.ts | Post types |
| enums/tasks.ts | Task enums |
| enums/salesforce.ts | Salesforce enums |
| enums/projectReports.ts | Report enums |
| enums/projectDetailTab.ts | UI tab enums |
| enums/integrations/ | Integration-specific enums |
| interfaces/ | TypeScript interfaces (see below) |

### `lib/utils/interfaces/` — Type Definitions

| File | Types |
|------|-------|
| authenticated-request.ts | Authenticated request type |
| apiResponse.ts | API response structure |
| project.ts | Project interfaces |
| post.ts | Post interfaces |
| files.ts | File interfaces (IPreSignedUrlPayload, etc.) |
| subscription.ts | Subscription types |
| query.ts | Query parameter types |
| projectTasks.ts | Task types |
| location.ts | Location types |
| gallery.ts | Gallery types |
| saleForcesServices.ts | Salesforce types |
| schemaInterface.ts | Schema helpers |
| httpClientConfig.ts | HTTP client config |
| projectReports.ts | Report types |
| integrations/ | Integration-specific types |

### `lib/integrations/` — Third-Party Integration System

| File | Purpose |
|------|---------|
| providers/base.ts | Base integration provider class |
| providers/companyCam.ts | CompanyCam integration |
| providers/jobNimbus.ts | JobNimbus CRM integration |
| syncService.ts | Data synchronization |
| manager.ts | Integration orchestration |
| hooks.ts | Project/Post lifecycle hooks |
| webhookHelpers.ts | Webhook event handling |

### `lib/cron/` — Cron Jobs

| File | Purpose |
|------|---------|
| cron.ts | Main scheduler |
| cronHelper.ts | Cron utilities |
| helpers/gallery.ts | Gallery auto-cleanup |

---

## Data Flow Examples

### Creating a Post
```
POST /api/posts
  → auth middleware (JWT)
  → PostRouter.index.ts (registers route)
  → PostRoutes.routes.ts (validates request, calls helper)
  → PostHelpers.helpers.ts (inserts into Posts collection, handles files)
  → awsBucket service (S3 upload if media)
  → notifications service (notify project members)
  → SuccessResponse()
```

### External API Request
```
GET /v1/projects
  → rateLimiter middleware
  → ApiKeyMiddleware (validates API key)
  → ExternalProjectRoutes (handler)
  → project helpers (DB query)
  → SuccessResponse()
```

### Webhook Processing
```
POST /webhook/stripe
  → Raw body parser
  → Stripe signature verification
  → Webhook handler (updates subscription/payment records)
```

---

## Third-Party Services

| Service | SDK/Library | Used For |
|---------|-------------|----------|
| AWS S3 | aws-sdk | File storage, presigned URLs |
| Stripe | stripe | Payments, subscriptions |
| Firebase | firebase-admin | Push notifications |
| SendGrid | @sendgrid/mail | Transactional email |
| Twilio | twilio | SMS |
| GetStream | stream-chat | Real-time chat |
| Google | googleapis | OAuth, geocoding |
| RevenueCat | API calls | Mobile subscriptions |
| Salesforce | jsforce | CRM sync |
| JW Player | API calls | Video hosting |
| CompanyCam | API calls | Photo sync integration |
| JobNimbus | API calls | CRM integration |
