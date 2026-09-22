import * as mongoose from "mongoose";
import { UserSchema } from "./user";
import { PaymentSchema } from "./payment";
import { ReviewSchema } from "./review";
import { InvitedUserSchema } from "./invitedUsers";
import { RefundsSchema } from "./refund";
import { CompanySchema } from "./company";
import { SheetsSchema } from "./sheets";
import { FcmTokensSchema } from "./fcmTokens";
import { ProductSchema } from "./products";
import { OrdersSchema } from "./orders";
import { SubscriptionSchema } from "./subscription";
import { SubscriptionPlanSchema } from "./subscriptionPlan";
import { ReferralsSchema } from "./referrals";
import { NotificationSchema } from "./notifications";
import { otpSchema } from "./otp";
import { ContactChangeOtpSchema } from "./contactChangeOtp";
import { ContactChangeReauthSchema } from "./contactChangeReauth";
import { ProjectSchema } from "./projects";
import { PostSchema } from "./posts";
import { CommentSchema } from "./comments";
import { ProjectMemberSchema } from "./projectMembers";
import { ProjectPinSchema } from "./projectPins";
import { CompanyMemberSchema } from "./companyMembers";
import { ProjectNotesSchema } from "./projectNotes";
import { ProjectTaskSchema } from "./projectTasks";
import { TagsSchema } from "./tags";
import { LikesSchema } from "./likes";
import { ReportsSchema } from "./report";
import { ActivityLogsSchema } from "./activityLogs";
import { RevenueCatLogsSchema } from "./revenueCatLogs";
import { UrlsSchema } from "./urls";
import { GallerySchema } from "./gallery";
import { GalleryFilesSchema } from "./galleryFiles";
import { ChecklistSchema } from "./checklist";
import { TodoListSchema } from "./todoList";
import { DailyLogsSchema } from "./dailyLogs";
import { AiProjectUpdatesSchema } from "./aiProjectUpdates";
import { ProjectReportsSchema } from "./projectReports";
import { ProjectReportsSectionSchema } from "./projectReportSection";
import { ProjectReportsSubSectionSchema } from "./projectReportSubSection";
import { StripePostPaymentSchema } from "./stripePostPayment";
import { TodoListImagesSchema } from "./todoListImages";
import { ApiKeySchema } from "./apiKeys";
import { CrewsSchema } from "./crews";
import { CrewsMembersSchema } from "./crewsMembers";
import { CrewsProjectsSchema } from "./crewsProjects";
import { FilesKeySchema } from "./files";
import { DeletedPostFilesSchema } from "./deletedPostFiles";
import { PostFilesSchema } from "./postFiles";
import { PendingUploadSchema } from "./pendingUploads";
import { IntegrationSchema } from "./integration";
import { SyncJobSchema } from "./syncJob";
import { ProcessedWebhookSchema } from "./processedWebhook";
import { ErrorLogsSchema } from "./errorLogs";
import { SearchBackfillStateSchema } from "./searchBackfillState";
import { SearchResumeTokenSchema } from "./searchResumeTokens";
import { SearchFlagSchema } from "./searchFlags";
import { SearchJobSchema } from "./searchJobs";
import { SearchRouteDefaultSchema } from "./searchRouteDefaults";
import { UserSettingsSchema } from "./userSettings";
import { RevenueEventSchema } from "./revenueEvents";

export const User = mongoose.model("User", UserSchema);
export const Payment = mongoose.model("Payment", PaymentSchema);
export const Review = mongoose.model("Review", ReviewSchema);
export const InvitedUsers = mongoose.model("InvitedUsers", InvitedUserSchema);
export const Refund = mongoose.model("Refund", RefundsSchema);
export const Company = mongoose.model("Company", CompanySchema);
export const FcmTokens = mongoose.model("FcmTokens", FcmTokensSchema);
export const Products = mongoose.model("Products", ProductSchema);
export const Orders = mongoose.model("Orders", OrdersSchema);
export const Referrals = mongoose.model("Referrals", ReferralsSchema);
export const Subscription = mongoose.model("Subscription", SubscriptionSchema);
export const SubscriptionPlan = mongoose.model(
  "SubscriptionPlan",
  SubscriptionPlanSchema,
);
export const Notification = mongoose.model("Notification", NotificationSchema);
export const Otp = mongoose.model("otp", otpSchema);
export const ContactChangeOtp = mongoose.model(
  "contactChangeOtp",
  ContactChangeOtpSchema,
);
// The unique {userId,type} index is load-bearing (resend throttle +
// single-pending-doc invariant). autoIndex swallows build failures silently
// (e.g. an options conflict with a pre-existing non-unique index), so surface
// them loudly — if this logs, drop the stale index so the constraint applies.
ContactChangeOtp.on("index", (err) => {
  if (err) {
    console.error("contactChangeOtp index build failed:", err.message);
  }
});
export const ContactChangeReauth = mongoose.model(
  "contactChangeReauth",
  ContactChangeReauthSchema,
);
ContactChangeReauth.on("index", (err) => {
  if (err) {
    console.error("contactChangeReauth index build failed:", err.message);
  }
});
export const Project = mongoose.model("project", ProjectSchema);
export const ProjectMember = mongoose.model(
  "projectMember",
  ProjectMemberSchema,
);
export const ProjectPin = mongoose.model("projectPin", ProjectPinSchema);
export const CompanyMember = mongoose.model(
  "companyMember",
  CompanyMemberSchema,
);
export const Comments = mongoose.model("comment", CommentSchema);
export const Posts = mongoose.model("post", PostSchema);
export const ProjectNotes = mongoose.model("projectNotes", ProjectNotesSchema);
export const ProjectTasks = mongoose.model("projectTask", ProjectTaskSchema);
export const Tags = mongoose.model("Tags", TagsSchema);
export const Likes = mongoose.model("likes", LikesSchema);
export const Report = mongoose.model("report", ReportsSchema);
export const ActivityLogs = mongoose.model("activityLogs", ActivityLogsSchema);
export const Gallery = mongoose.model("gallery", GallerySchema);
export const GalleryFiles = mongoose.model("galleryFiles", GalleryFilesSchema);
export const RevenueCatlogs = mongoose.model(
  "RevenueCatlogs",
  RevenueCatLogsSchema,
);
export const Urls = mongoose.model("Urls", UrlsSchema);
export const Checklist = mongoose.model("Checklist", ChecklistSchema);
export const TodoList = mongoose.model("TodoList", TodoListSchema);
export const TodoListImages = mongoose.model(
  "TodoListImages",
  TodoListImagesSchema,
);
export const ProjectReports = mongoose.model(
  "ProjectReport",
  ProjectReportsSchema,
);
export const DailyLogs = mongoose.model("DailyLog", DailyLogsSchema);
export const Sheets = mongoose.model("Sheet", SheetsSchema);
export const AiProjectUpdates = mongoose.model(
  "AiProjectUpdate",
  AiProjectUpdatesSchema,
);
export const ProjectReportsSection = mongoose.model(
  "ProjectReportSection",
  ProjectReportsSectionSchema,
);
export const ProjectReportsSubSection = mongoose.model(
  "ProjectReportSubSection",
  ProjectReportsSubSectionSchema,
);
export const Crews = mongoose.model("Crews", CrewsSchema);
export const CrewsMembers = mongoose.model("CrewsMember", CrewsMembersSchema);
export const CrewsProjects = mongoose.model(
  "CrewsProject",
  CrewsProjectsSchema,
);
export const StripePostPayment = mongoose.model(
  "StripePostPayment",
  StripePostPaymentSchema,
);

export const ApiKey = mongoose.model("ApiKey", ApiKeySchema);
export const Files = mongoose.model("Files", FilesKeySchema);
export const DeletedPostFiles = mongoose.model(
  "DeletedPostFiles",
  DeletedPostFilesSchema,
);
export const PostFiles = mongoose.model("postFiles", PostFilesSchema);
export const PendingUpload = mongoose.model(
  "PendingUpload",
  PendingUploadSchema,
);

// CRM Integrations
export const Integration = mongoose.model("Integration", IntegrationSchema);
export const SyncJob = mongoose.model("SyncJob", SyncJobSchema);
export const ProcessedWebhook = mongoose.model(
  "ProcessedWebhook",
  ProcessedWebhookSchema,
);

export const ErrorLogs = mongoose.model("errorLogs", ErrorLogsSchema);

// Search backfill restart-safety checkpoint.
export const SearchBackfillState = mongoose.model(
  "SearchBackfillState",
  SearchBackfillStateSchema,
);

// Change-stream resume tokens.
export const SearchResumeToken = mongoose.model(
  "SearchResumeToken",
  SearchResumeTokenSchema,
);

// Per-company × per-route ES feature flag.
export const SearchFlag = mongoose.model("SearchFlag", SearchFlagSchema);

// Reindex job queue.
export const SearchJob = mongoose.model("SearchJob", SearchJobSchema);

// Route-level default ES flag — enable/disable a route for all companies.
export const SearchRouteDefault = mongoose.model(
  "SearchRouteDefault",
  SearchRouteDefaultSchema,
);
export const UserSettings = mongoose.model("userSettings", UserSettingsSchema);

// Marketing revenue facts (see lib/db/revenueEvents.ts). The unique
// {payment_provider, provider_event_id} index enforces webhook idempotency;
// surface build failures loudly so a stale/conflicting index can't silently
// disable dedupe.
export const RevenueEvent = mongoose.model("RevenueEvent", RevenueEventSchema);
RevenueEvent.on("index", (err) => {
  if (err) {
    console.error("revenueEvents index build failed:", err.message);
  }
});

const allModel = {
  User,
};

export const findModel = (modelName: string) => {
  const model = allModel[modelName];
  if (model) {
    return model;
  }
};
