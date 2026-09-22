# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- **Runtime:** Node.js 18
- **Language:** TypeScript ~5.2.2 (ES5 target, rootDir: lib/, outDir: server/)
- **Framework:** Express ^4.18.2
- **Database:** MongoDB via Mongoose ^7.6.3
- **Auth:** Firebase Admin ^11.11.0 + JWT (jsonwebtoken ^9.0.2)
- **Storage:** AWS S3 (aws-sdk v2 ^2.1476.0 + @aws-sdk/client-s3 v3 ^3.433.0)
- **Queue:** AWS SQS (@aws-sdk/client-sqs ^3.1030.0) — async download jobs
- **Payments:** Stripe ^14.25.0
- **Chat:** Stream Chat ^8.13.1
- **Email:** SendGrid ^7.7.0
- **SMS:** Twilio ^4.18.1
- **AI:** OpenAI ^6.27.0
- **Logging:** Winston ^3.11.0
- **Validation:** node-input-validator ^4.5.1
- **Dates:** dayjs ^1.11.10
- **Testing:** Mocha ^10.2.0 + Chai ^4.3.10 + Sinon ^21.0.1
- **Linting:** ESLint ^8.51.0 + Prettier ^3.0.3 (semi: true)

## Critical Implementation Rules

### Language-Specific Rules (TypeScript)

- **No strict mode:** tsconfig does not enable `strict`. Do not add strict-mode-only patterns.
- **Relative imports only:** No path aliases. Use `../../` relative paths. DB models from `import { Model } from "../../db"`.
- **Namespace imports for external packages:** `import * as express from "express"`, `import * as status from "http-status"`.
- **Named exports, no defaults:** All classes and functions use named exports. No `export default`.
- **Error handling in routes:** Always wrap handler body in `try { ... } catch (error) { next(error); }`. Return `ErrorResponse()` for business logic failures (validation, access denied).
- **AuthenticatedRequest:** Always type `req` as `AuthenticatedRequest` in protected route handlers. Access user via `req.user`.
- **Interface naming:** Domain types use `Type` suffix (e.g., `CommentType`). Place in `lib/utils/interfaces/`.
- **ObjectId helper:** Use `ObjectId()` from `lib/utils/helpers/commonHelper.ts` to cast strings, not raw `new mongoose.Types.ObjectId()`.

### Framework-Specific Rules (Express + Mongoose)

- **3-file route module:** Every feature in `lib/routes/{module}/` must have `index.ts` (Router class), `routes.ts` (handler class with static methods), `helper.ts` (DB logic class with static methods).
- **Static class pattern:** All route handlers and helpers are `public static` arrow functions on a class. No standalone functions.
- **Router middleware order:** Public routes before `authMiddleware`. Protected routes after. Role checks in handlers, not at router level.
- **API middleware chain:** Integration routes (no auth) → `jwtDecoder` (global) → feature routers → admin routes (admin middleware) → super-admin routes.
- **Validation required:** Every endpoint must validate input using `node-input-validator`. Pattern: `new Validator(req.body, rules)` → `check()` → `ErrorResponse` on failure.
- **Response helpers only:** Never use `res.json()` directly. Always `SuccessResponse()` or `ErrorResponse()` from `lib/utils/helpers/apiResponse.ts`.
- **Mongoose .lean():** Always use `.lean()` on read-only queries for performance.
- **Mongoose timestamps:** All schemas must include `{ timestamps: true }`.
- **Aggregation for joins:** Use `$lookup` pipelines for joining collections. Use `createFacetPipeline()` from commonHelper for pagination.
- **Schema indexes:** Define indexes on frequently queried fields. Use compound indexes for multi-field queries.

### Testing Rules

- **Test environment:** Tests use `.env.spec` — NEVER run tests against production or dev DB. Always verify `DB_PATH` in `.env.spec` points to a test database.
- **Test stack:** Mocha (runner) + Chai (assertions) + Sinon (stubs/spies) + chai-http (HTTP integration tests) + Nock (external HTTP mocking).
- **Test command:** `npm run server-test` — compiles TypeScript first, then runs Mocha with 10s timeout.
- **External service mocking:** Use Nock for mocking HTTP calls to Stripe, SendGrid, Twilio, etc. Never make real external API calls in tests.
- **Test file location:** Place test files in `test/` directory at project root.

### Code Quality & Style Rules

- **Prettier:** semi: true. No other overrides. Run `npm run format` to auto-format.
- **Pre-commit:** lint-staged runs ESLint + Prettier on staged `.ts` files automatically.
- **Never edit server/:** Only edit TypeScript in `lib/`. The `server/` directory is compiled output.
- **Directory naming:** camelCase for all directories (`projectTasks/`, `projectNotes/`).
- **File naming:** camelCase for all files (`awsBucket.ts`, `commonHelper.ts`).
- **Class naming:** PascalCase with role suffix — `{Feature}Router`, `{Feature}Routes`, `{Feature}Helper`.
- **Method naming:** camelCase static arrow functions: `public static methodName = async (...)`.
- **Interface naming:** PascalCase with `Type` suffix (`CommentType`). Place in `lib/utils/interfaces/`.
- **Schema naming:** PascalCase with `Schema` suffix (`UserSchema`). Place in `lib/db/`.
- **Comments:** Brief comments on complex logic only. No JSDoc. No over-commenting obvious code.

### Development Workflow Rules

- **Branch naming:** `{username}/{type}/{description}` — e.g., `ashutosh/fix/AIReportMapping`, `naval/feat/newFeature`.
- **Commit messages:** Lowercase `type: description` — e.g., `fix: image transform`, `feat: add gallery endpoint`.
- **PR target:** Always merge into `develop` branch. Never push directly to `main`/`master`.
- **Type check after changes:** Always run `tsc --noEmit` after modifying TypeScript to catch errors. Ignore pre-existing errors unrelated to your changes.
- **Dev requires two processes:** `npm run tsc-watch` (compiler) + `npm run server` (nodemon). Or one-shot: `npm run tsc && npm run server`.
- **Firebase emulator:** Required for local auth testing. Start with `firebase emulators:start`. UI at `http://localhost:4001/`.
- **Cron is separate:** Cron jobs run via `npm run cron-server` on a separate port (`CRON_PORT`).
- **Never commit secrets:** `.env` files are gitignored. Check `DB_PATH` before any DB operations.

### Critical Don't-Miss Rules

- **Business logic in helpers only:** Route handlers (`routes.ts`) extract params, validate, and return responses. All DB queries and logic go in `helper.ts`.
- **No standalone functions:** Always use `public static` methods on a class. No free-floating `export function`.
- **No export default:** Entire codebase uses named exports exclusively.
- **New models must register:** Any new Mongoose model in `lib/db/` must be exported from `lib/db/index.ts`.
- **New routes must register:** Any new route module must be mounted in `lib/routes/api.ts` with correct middleware positioning.
- **Integration routes = no JWT:** Routes under `/api/integrations` are mounted before `jwtDecoder`. They manage their own authentication.
- **Webhook raw body:** Webhook routes need raw request bodies for signature verification. Don't add JSON parsing middleware to webhook paths.
- **DB safety:** Never run migrations or bulk updates without confirming which `DB_PATH` is active. Default to staging.
- **Parallel DB calls:** Use `Promise.all()` when making multiple independent database lookups.
- **No internal error exposure:** Error messages in `ErrorResponse` must be user-friendly. Never leak stack traces or internal details.
- **Posts need `companyId`:** Any code path that creates a `Posts` document (including `PostsHelper.moveFilesToProject`) must populate `companyId`. Grid-view and timeline reads match on `Posts.companyId` directly — posts without it are invisible to those queries.
- **Use `AWSSQSService.getInstance()`:** The SQS client is a singleton in `lib/services/awsSqs.ts`. Never construct a new `SQSClient` — credentials and region are wired through the singleton config.
- **Long-running responses pattern:** For SQS-backed endpoints (e.g. `GET /api/files/download`) call `SuccessResponse(...)` first to release the client, then continue async work. Do not return another response after that — log errors instead.
- **`createSingleDownloadJob` over multi-message:** Prefer `createSingleDownloadJob` for new download flows. It transparently switches to an S3 manifest (`S3_DOWNLOAD_BUCKET/download-manifests/{jobId}.json`) when the payload exceeds ~200 KB. The legacy multi-message variants exist only for backward-compatible callers.
- **Job IDs are Mongo ObjectIds:** `awsSqs.ts` builds job IDs as `new Types.ObjectId().toString()`. Don't reintroduce `uuid` for jobs — keeps IDs lookup-compatible with other Mongo collections.
- **User deletion must clean crews:** When deleting a user, call `UserHelper.removeUserFromCrews(userId)` in addition to firebase/notifications/fcm cleanup. Skipping it leaves orphaned `CrewsMember` rows.
- **`showDefaultTags` gate:** `GET /api/tags` returns the system default tag list only when `Company.showDefaultTags !== false`. Treat a missing/undefined flag as enabled. New tag callers that mix defaults + custom must replicate this check.

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code
- Follow ALL rules exactly as documented
- When in doubt, prefer the more restrictive option
- Update this file if new patterns emerge

**For Humans:**

- Keep this file lean and focused on agent needs
- Update when technology stack changes
- Review quarterly for outdated rules
- Remove rules that become obvious over time

