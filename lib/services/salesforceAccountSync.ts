import { Types } from "mongoose";
import {
  Checklist,
  Company,
  CompanyMember,
  Files,
  PostFiles,
  Posts,
  Project,
  ProjectMember,
  ProjectReports,
  User,
} from "../db";
import { SalesForceService } from "./salesforce";
import {
  CURRENT_STATUS,
  MEMBER_TYPE,
  SUBSCRIPTION_STATUS,
  USER_ROLE,
} from "../utils/enums/enums";
import { CHECKLIST_STATUS, CHECKLIST_TYPE } from "../utils/enums/checklist";
import { REPORT_SOURCE, REPORT_STATUS } from "../utils/enums/projectReports";
import {
  SALESFORCE_COMPOSITE_BATCH_SIZE,
  SALESFORCE_CONVERTED_LEAD_ERROR,
  SALESFORCE_PUSH_BATCH_SIZE,
  SALESFORCE_STALE_ID_ERRORS,
} from "../utils/enums/salesforce";
import { subscriptionPlanUsers } from "../utils/constants/constants";
import { ObjectId } from "../utils/helpers/commonHelper";
import {
  IAccountSnapshot,
  ICompanyCountRow,
  ICompanyMemberStatsRow,
  ICompanyUsageMaps,
  ICreateLead,
  ILeadResolutionSummary,
  ISalesforceCompositeRecord,
  ISalesforceCompositeResult,
  ISalesforceContactIdentity,
  ISalesforceContactRecord,
  ISalesforceLeadConversion,
  ISalesforceLeadIdentity,
  ISalesforceLeadRecord,
  ISalesforceSnapshotFields,
  ISalesforceSyncSummary,
  ISyncFailure,
} from "../utils/interfaces/saleForcesServices";

interface ICompanyRow {
  _id: Types.ObjectId;
  name?: string;
  userId?: Types.ObjectId;
  teamLimit?: number;
  createdAt?: Date;
}

interface IAdminUserRow {
  _id: Types.ObjectId;
  email?: string;
  phone?: string;
  name?: { first?: string; last?: string };
  userRole?: string;
  roles?: string;
  stripeCustomerId?: string;
  subscriptionStatus?: string;
  subscriptionActiveUntil?: Date;
  subscriptionBoughtFrom?: string;
  subscriptionPlan?: string;
  referredBy?: Types.ObjectId;
  salesforceLeadId?: string;
  salesforceContactId?: string;
  createdAt?: Date;
}

interface IGuestUserRow {
  _id: Types.ObjectId | null;
  count: number;
}

/**
 * Pushes company-level account state (usage counters, seats, subscription) onto
 * the Salesforce Lead of each company's admin, so account managers can see the
 * health of an account without leaving Salesforce.
 *
 * Every counter is scoped to the whole company, not the individual admin — a
 * lead reads as "everything the ABC Company team has done".
 */
export class SalesforceAccountSyncService {
  /**
   * Creates the lead for a brand-new admin and stores its record Id on the user,
   * so the nightly sync can update it directly and never has to resolve it by
   * email. Fire-and-forget — a Salesforce problem must never fail a signup.
   */
  public static createAndLinkLead(
    userId: Types.ObjectId,
    leadData: ICreateLead,
  ): void {
    SalesForceService.createLead(leadData)
      .then((lead) => {
        if (!lead?.id) return;
        return User.findByIdAndUpdate(userId, {
          $set: { salesforceLeadId: lead.id },
        });
      })
      .catch(() => {
        /* createLead already alerts on failure */
      });
  }

  /** Rolls a `$group by companyId` aggregation into a companyId -> count map. */
  private static toCountMap(rows: ICompanyCountRow[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const row of rows) {
      if (row._id) map.set(String(row._id), row.count);
    }
    return map;
  }

  /**
   * Collects every usage counter in one pass per collection, grouped by company,
   * rather than per-company queries. For the nightly full run this keeps the work
   * at O(collections) instead of O(companies x collections) — ~10 aggregations
   * instead of tens of thousands of point queries.
   *
   * The optional `companyIds` narrows every stage to those companies so a
   * targeted run hits indexes instead of re-scanning the whole database.
   * Checklists have no companyId index, so that one stage is a scan either way,
   * which is part of why the nightly run is scheduled off-peak.
   */
  public static async collectUsageStats(
    companyIds?: Types.ObjectId[],
  ): Promise<ICompanyUsageMaps> {
    const groupByCompany = {
      $group: { _id: "$companyId", count: { $sum: 1 } },
    };
    const scoped = Boolean(companyIds?.length);
    const companyScope = scoped ? { companyId: { $in: companyIds } } : {};

    // projectMembers has no companyId, so a scoped guest lookup is narrowed by
    // the company's project ids instead — that hits the {projectId, userId} index.
    const guestScope = scoped
      ? {
          projectId: {
            $in: (
              await Project.find(companyScope, { _id: 1 }).lean<
                { _id: Types.ObjectId }[]
              >()
            ).map((project) => project._id),
          },
        }
      : {};

    const [
      projectCounts,
      postCounts,
      postFileCounts,
      documentFileCounts,
      checklistCounts,
      reportCounts,
      aiActionCounts,
      guestRows,
      memberRows,
    ] = await Promise.all([
      Project.aggregate<ICompanyCountRow>([
        { $match: { ...companyScope, status: CURRENT_STATUS.ACTIVE } },
        groupByCompany,
      ]),
      Posts.aggregate<ICompanyCountRow>([
        { $match: { ...companyScope, status: CURRENT_STATUS.ACTIVE } },
        groupByCompany,
      ]),
      PostFiles.aggregate<ICompanyCountRow>([
        { $match: { ...companyScope, status: CURRENT_STATUS.ACTIVE } },
        groupByCompany,
      ]),
      Files.aggregate<ICompanyCountRow>([
        { $match: { ...companyScope, status: CURRENT_STATUS.ACTIVE } },
        groupByCompany,
      ]),
      Checklist.aggregate<ICompanyCountRow>([
        {
          $match: {
            ...companyScope,
            type: CHECKLIST_TYPE.CHECKLIST,
            status: { $ne: CHECKLIST_STATUS.DELETED },
          },
        },
        groupByCompany,
      ]),
      ProjectReports.aggregate<ICompanyCountRow>([
        { $match: { ...companyScope, status: REPORT_STATUS.ACTIVE } },
        groupByCompany,
      ]),
      ProjectReports.aggregate<ICompanyCountRow>([
        {
          $match: {
            ...companyScope,
            status: REPORT_STATUS.ACTIVE,
            reportSource: REPORT_SOURCE.AI,
          },
        },
        groupByCompany,
      ]),
      // projectMembers carries no companyId, so guests are resolved through
      // their project. Distinct users, not memberships — one guest on three
      // projects is one guest user.
      ProjectMember.aggregate<IGuestUserRow>([
        {
          $match: {
            ...guestScope,
            type: MEMBER_TYPE.GUEST,
            status: CURRENT_STATUS.ACTIVE,
          },
        },
        {
          $lookup: {
            from: "projects",
            localField: "projectId",
            foreignField: "_id",
            as: "project",
          },
        },
        { $unwind: "$project" },
        {
          $group: {
            _id: "$project.companyId",
            users: { $addToSet: "$userId" },
          },
        },
        { $project: { count: { $size: "$users" } } },
      ]),
      // Active seats and the freshest activity across the whole team in one pass.
      CompanyMember.aggregate<ICompanyMemberStatsRow>([
        { $match: { ...companyScope, status: CURRENT_STATUS.ACTIVE } },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $group: {
            _id: "$companyId",
            activeLicenses: { $sum: 1 },
            lastActivity: { $max: "$user.lastActivity" },
          },
        },
      ]),
    ]);

    const memberStats = new Map<
      string,
      { activeLicenses: number; lastActivity: Date | null }
    >();
    for (const row of memberRows) {
      if (!row._id) continue;
      memberStats.set(String(row._id), {
        activeLicenses: row.activeLicenses,
        lastActivity: row.lastActivity ? new Date(row.lastActivity) : null,
      });
    }

    return {
      projectCounts: this.toCountMap(projectCounts),
      postCounts: this.toCountMap(postCounts),
      postFileCounts: this.toCountMap(postFileCounts),
      documentFileCounts: this.toCountMap(documentFileCounts),
      checklistCounts: this.toCountMap(checklistCounts),
      reportCounts: this.toCountMap(reportCounts),
      aiActionCounts: this.toCountMap(aiActionCounts),
      guestProjectUserCounts: this.toCountMap(guestRows),
      memberStats,
    };
  }

  /**
   * Mirrors the app's own status derivation: an account that never subscribed
   * shows as EXPIRED once the trial window has passed, so Salesforce agrees with
   * what the customer sees in-product.
   */
  private static resolveSubscriptionStatus(admin: IAdminUserRow): string {
    const stored =
      admin.subscriptionStatus || SUBSCRIPTION_STATUS.NO_SUBSCRIPTION;
    if (stored !== SUBSCRIPTION_STATUS.NO_SUBSCRIPTION) return stored;

    const createdAt = admin.createdAt ? new Date(admin.createdAt).getTime() : 0;
    if (!createdAt) return stored;

    return SUBSCRIPTION_STATUS.NO_SUBSCRIPTION;
  }

  /**
   * Seats the account paid for. Stripe purchases write an explicit teamLimit on
   * the company; RevenueCat purchases only carry a plan name, so the seat count
   * is derived from the plan tier — same precedence the login path uses.
   */
  private static resolvePurchasedLicenses(
    company: ICompanyRow,
    admin: IAdminUserRow,
  ): number {
    const planTier = admin.subscriptionPlan?.split(/[_-]/)?.[0];
    const planSeats = subscriptionPlanUsers(planTier);
    return Math.max(company.teamLimit || 0, planSeats);
  }

  /** Joins companies with their admin user and the pre-computed usage maps. */
  public static async buildAccountSnapshots(
    companyIds?: Types.ObjectId[],
  ): Promise<IAccountSnapshot[]> {
    const companyFilter: Record<string, unknown> = {
      status: CURRENT_STATUS.ACTIVE,
    };
    if (companyIds?.length) companyFilter._id = { $in: companyIds };

    const [companies, usage] = await Promise.all([
      Company.find(companyFilter, {
        name: 1,
        userId: 1,
        teamLimit: 1,
        createdAt: 1,
      }).lean<ICompanyRow[]>(),
      this.collectUsageStats(companyIds),
    ]);

    const adminIds = companies
      .map((company) => company.userId)
      .filter((userId): userId is Types.ObjectId => Boolean(userId));

    if (!adminIds.length) return [];

    const admins = await User.find(
      { _id: { $in: adminIds } },
      {
        email: 1,
        phone: 1,
        name: 1,
        userRole: 1,
        roles: 1,
        stripeCustomerId: 1,
        subscriptionStatus: 1,
        subscriptionActiveUntil: 1,
        subscriptionBoughtFrom: 1,
        subscriptionPlan: 1,
        referredBy: 1,
        salesforceLeadId: 1,
        salesforceContactId: 1,
        createdAt: 1,
      },
    ).lean<IAdminUserRow[]>();

    const adminById = new Map(
      admins.map((admin) => [String(admin._id), admin]),
    );

    const referrerIds = admins
      .map((admin) => admin.referredBy)
      .filter((id): id is Types.ObjectId => Boolean(id));

    // Company-scoped role for the admin, and the email of whoever referred them.
    const [adminMemberships, referrers] = await Promise.all([
      CompanyMember.find(
        { userId: { $in: adminIds }, status: CURRENT_STATUS.ACTIVE },
        { companyId: 1, userId: 1, role: 1 },
      ).lean<
        { companyId: Types.ObjectId; userId: Types.ObjectId; role?: string }[]
      >(),
      referrerIds.length
        ? User.find({ _id: { $in: referrerIds } }, { email: 1 }).lean<
            { _id: Types.ObjectId; email?: string }[]
          >()
        : Promise.resolve([]),
    ]);

    const roleByCompanyUser = new Map(
      adminMemberships.map((membership) => [
        `${membership.companyId}:${membership.userId}`,
        membership.role,
      ]),
    );
    const referrerEmailById = new Map(
      referrers.map((referrer) => [String(referrer._id), referrer.email || ""]),
    );

    const snapshots: IAccountSnapshot[] = [];

    for (const company of companies) {
      const admin = company.userId
        ? adminById.get(String(company.userId))
        : undefined;

      // No admin user, or an admin with no email, can't be matched to a lead.
      if (!admin?.email) continue;

      const key = String(company._id);
      const members = usage.memberStats.get(key);
      const subscriptionEnds = admin.subscriptionActiveUntil
        ? new Date(admin.subscriptionActiveUntil)
        : null;

      snapshots.push({
        companyId: key,
        adminUserId: String(admin._id),
        salesforceLeadId: admin.salesforceLeadId || "",
        salesforceContactId: admin.salesforceContactId || "",
        companyName: company.name || "",
        joinedOn: company.createdAt || admin.createdAt || new Date(),
        firstName: admin.name?.first || "",
        lastName: admin.name?.last || admin.name?.first || "",
        email: admin.email,
        phone: admin.phone || "",
        title: admin.userRole || "",
        role:
          roleByCompanyUser.get(`${company._id}:${admin._id}`) ||
          admin.roles ||
          USER_ROLE.ADMIN,
        invitedBy: admin.referredBy
          ? referrerEmailById.get(String(admin.referredBy)) || ""
          : "",
        subscriptionStatus: this.resolveSubscriptionStatus(admin),
        subscriptionEnds,
        purchaseMethod: admin.subscriptionBoughtFrom || "",
        stripeCustomerId: admin.stripeCustomerId || "",
        purchasedLicenses: this.resolvePurchasedLicenses(company, admin),
        activeLicenses: members?.activeLicenses || 0,
        lastActivity: members?.lastActivity || null,
        projectCount: usage.projectCounts.get(key) || 0,
        postCount: usage.postCounts.get(key) || 0,
        // Photos on posts plus standalone project documents = all files stored.
        fileCount: usage.documentFileCounts.get(key) || 0,
        checklistCount: usage.checklistCounts.get(key) || 0,
        reportCount: usage.reportCounts.get(key) || 0,
        // No dedicated AI instrumentation exists yet; AI-sourced reports are the
        // only real AI usage signal in the database.
        aiActionCount: usage.aiActionCounts.get(key) || 0,
        guestProjectUsers: usage.guestProjectUserCounts.get(key) || 0,
      });
    }

    return snapshots;
  }

  /** Maps a snapshot onto the field API names shown in the CrewCam Sync section. */
  private static toSnapshotFields(
    snapshot: IAccountSnapshot,
  ): ISalesforceSnapshotFields {
    return {
      RelayCam_Org_ID__c: snapshot.companyId,
      // Identity fields are required for the create half of the upsert.
      FirstName: snapshot.firstName,
      LastName: snapshot.lastName || snapshot.email,
      Email: snapshot.email,
      Phone: snapshot.phone,
      Title: snapshot.title,
      Role__c: snapshot.role,
      Invited_By__c: snapshot.invitedBy,
      Subscription_Status__c: snapshot.subscriptionStatus,
      Purchased_Licenses__c: snapshot.purchasedLicenses,
      Active_Licenses__c: snapshot.activeLicenses,
      Subscription_Ends__c: snapshot.subscriptionEnds?.toISOString(),
      Purchase_Method__c: snapshot.purchaseMethod,
      Stripe_ID__c: snapshot.stripeCustomerId,
      Joined_On__c: snapshot.joinedOn.toISOString(),
      Last_Activity__c: snapshot.lastActivity?.toISOString(),
      Project_Count__c: snapshot.projectCount,
      Post_Count__c: snapshot.postCount,
      File_Count__c: snapshot.fileCount,
      Checklist_Count__c: snapshot.checklistCount,
      Report_Count__c: snapshot.reportCount,
      AI_Actions_Count__c: snapshot.aiActionCount,
      Guest_Project_Users__c: snapshot.guestProjectUsers,
    };
  }

  private static toLeadRecord(
    snapshot: IAccountSnapshot,
  ): ISalesforceLeadRecord {
    return {
      attributes: { type: "Lead" },
      ...this.toSnapshotFields(snapshot),
      Company: snapshot.companyName || snapshot.email,
    };
  }

  /** The same snapshot addressed at the Contact a converted lead became. */
  private static toContactRecord(
    snapshot: IAccountSnapshot,
  ): ISalesforceContactRecord {
    return {
      attributes: { type: "Contact" },
      id: snapshot.salesforceContactId,
      ...this.toSnapshotFields(snapshot),
    };
  }

  /**
   * Sends the snapshot to whichever record is writable: the Contact once the
   * lead has been converted, otherwise the lead itself.
   */
  private static toTargetRecord(
    snapshot: IAccountSnapshot,
  ): ISalesforceCompositeRecord {
    if (snapshot.salesforceContactId) return this.toContactRecord(snapshot);

    return { ...this.toLeadRecord(snapshot), id: snapshot.salesforceLeadId };
  }

  private static chunk<T>(items: T[], size: number): T[][] {
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      batches.push(items.slice(index, index + size));
    }
    return batches;
  }

  private static describeErrors(result: ISalesforceCompositeResult): string {
    if (!result.errors?.length) return "Unknown Salesforce error";
    return result.errors
      .map((error) => `${error.statusCode}: ${error.message}`)
      .join("; ");
  }

  /**
   * The nightly entry point: makes sure every admin has a stored lead Id, then
   * pushes current account state.
   *
   * Snapshots are built once and shared by both steps so the usage aggregation
   * runs a single time.
   */
  public static async runDailySync(companyIds?: Types.ObjectId[]): Promise<{
    resolution: ILeadResolutionSummary;
    push: ISalesforceSyncSummary;
  }> {
    const snapshots = await this.buildAccountSnapshots(companyIds);

    const resolution = await this.resolveMissingLeadIds(snapshots);
    const push = await this.pushSnapshots(snapshots, companyIds);

    return { resolution, push };
  }

  /**
   * Fills in salesforceLeadId for admins that don't have one, then persists it to
   * Mongo so it's never looked up again. Two cases:
   *
   *  - a lead already exists (created before this feature, or by sales) — matched
   *    on email and linked;
   *  - only a converted lead exists — the Contact it became is linked instead, so
   *    the sales team's converted account isn't shadowed by a duplicate lead;
   *  - no lead exists but a Contact does — that Contact is linked, because the
   *    Lead duplicate rule would reject a new lead matching it anyway;
   *  - Salesforce has neither — a lead is created and its new Id stored.
   *
   * The work set shrinks to nothing as Ids accumulate, so after the first run
   * this costs no Salesforce calls at all. Snapshots are mutated in place so the
   * push step immediately sees the Ids resolved here.
   */
  public static async resolveMissingLeadIds(
    snapshots: IAccountSnapshot[],
  ): Promise<ILeadResolutionSummary> {
    const unresolved = snapshots.filter(
      (snapshot) => !snapshot.salesforceLeadId && !snapshot.salesforceContactId,
    );

    // Resolution is per person, not per company. An admin owning two companies
    // yields two snapshots, and creating a lead for each would leave two leads on
    // one email — then, since CrewCam_Org_ID__c is unique across leads, whichever
    // company loses the push-side dedupe next run collides with the org id sitting
    // on the sibling lead (DUPLICATE_VALUE). One lead per email, shared by both.
    const byEmail = new Map<string, IAccountSnapshot[]>();
    for (const snapshot of unresolved) {
      const email = snapshot.email.toLowerCase();
      const group = byEmail.get(email);
      if (group) group.push(snapshot);
      else byEmail.set(email, [snapshot]);
    }
    const pending = Array.from(byEmail.values(), (group) => group[0]);

    const summary: ILeadResolutionSummary = {
      needingResolution: pending.length,
      matchedByEmail: 0,
      matchedContacts: 0,
      createdLeads: 0,
      failed: 0,
      failures: [],
    };

    if (!pending.length) return summary;

    for (const batch of this.chunk(pending, SALESFORCE_COMPOSITE_BATCH_SIZE)) {
      const emailList = batch
        .map((snapshot) => `'${SalesForceService.escapeSoql(snapshot.email)}'`)
        .join(",");

      let leads: ISalesforceLeadIdentity[];
      try {
        // Converted leads are included so their Contact can be linked — writing to
        // the lead itself is impossible, but the account is still a real one.
        leads = await SalesForceService.query<ISalesforceLeadIdentity>(
          `SELECT Id, Email, IsConverted, ConvertedContactId FROM Lead WHERE Email IN (${emailList})`,
        );
      } catch (error) {
        this.recordBatchFailure(summary.failures, batch, error);
        summary.failed += batch.length;
        continue;
      }

      const leadByEmail = new Map<string, ISalesforceLeadIdentity>();
      for (const lead of leads) {
        const email = lead.Email?.toLowerCase();
        if (!email) continue;

        // First match wins — a duplicate email in Salesforce is the sales team's
        // to merge, and picking one consistently beats failing the account. An
        // open lead outranks a converted one, since it accepts writes directly.
        const current = leadByEmail.get(email);
        if (!current || (current.IsConverted && !lead.IsConverted))
          leadByEmail.set(email, lead);
      }

      const unmatched: IAccountSnapshot[] = [];
      for (const snapshot of batch) {
        const existing = leadByEmail.get(snapshot.email.toLowerCase());
        const contactId = existing?.IsConverted
          ? existing.ConvertedContactId
          : null;

        if (existing && !existing.IsConverted) {
          snapshot.salesforceLeadId = existing.Id;
          summary.matchedByEmail += 1;
        } else if (contactId) {
          snapshot.salesforceContactId = contactId;
          summary.matchedByEmail += 1;
        } else {
          unmatched.push(snapshot);
        }
      }

      // No lead on this email doesn't mean Salesforce doesn't know the person: a
      // Contact may exist on its own, and the Lead duplicate rule matches leads
      // against contacts, so creating one would be rejected as a duplicate.
      // Linking that Contact both syncs the account and avoids the duplicate.
      const needCreate = await this.linkContactsByEmail(unmatched, summary);

      // Creates are chunked like the writes: a rejected record shouldn't cost the
      // other new admins their lead.
      for (const chunk of this.chunk(needCreate, SALESFORCE_PUSH_BATCH_SIZE)) {
        try {
          const results = await SalesForceService.createLeadsBulk(
            chunk.map((snapshot) => {
              const record = this.toLeadRecord(snapshot);
              delete record.id;
              return record;
            }),
          );

          results.forEach((result, index) => {
            const snapshot = chunk[index];
            if (result.success && result.id) {
              snapshot.salesforceLeadId = result.id;
              summary.createdLeads += 1;
              return;
            }
            summary.failed += 1;
            summary.failures.push({
              companyId: snapshot.companyId,
              email: snapshot.email,
              message: this.describeErrors(result),
            });
          });
        } catch (error) {
          this.recordBatchFailure(summary.failures, chunk, error);
          summary.failed += chunk.length;
        }
      }

      await Promise.all([
        this.persistLeadIds(batch),
        this.persistContactIds(batch),
      ]);
    }

    // Hand the resolved Id to the resolved admin's other companies, so the push
    // step sees them as targets and the push-side dedupe picks one.
    for (const group of Array.from(byEmail.values())) {
      const [resolved, ...siblings] = group;
      for (const sibling of siblings) {
        sibling.salesforceLeadId = resolved.salesforceLeadId;
        sibling.salesforceContactId = resolved.salesforceContactId;
      }
    }

    return summary;
  }

  /**
   * Last resort before creating a lead: match the remaining admins against
   * Contacts on email. A Contact with no lead behind it is common (imported, or
   * created directly by sales), and the Lead duplicate rule matches leads against
   * contacts — so creating a lead here is rejected as DUPLICATES_DETECTED and the
   * account would never sync. Returns the snapshots still needing a new lead.
   */
  private static async linkContactsByEmail(
    snapshots: IAccountSnapshot[],
    summary: ILeadResolutionSummary,
  ): Promise<IAccountSnapshot[]> {
    if (!snapshots.length) return [];

    const emailList = snapshots
      .map((snapshot) => `'${SalesForceService.escapeSoql(snapshot.email)}'`)
      .join(",");

    let contacts: ISalesforceContactIdentity[];
    try {
      contacts = await SalesForceService.query<ISalesforceContactIdentity>(
        `SELECT Id, Email FROM Contact WHERE Email IN (${emailList})`,
      );
    } catch (error) {
      // A failed lookup shouldn't block lead creation for the whole batch; the
      // duplicate rule stays the backstop for the few that do collide.
      console.error(
        "Salesforce contact lookup failed:",
        error instanceof Error ? error.message : error,
      );
      return snapshots;
    }

    const contactIdByEmail = new Map<string, string>();
    for (const contact of contacts) {
      const email = contact.Email?.toLowerCase();
      // First match wins, as with leads — merging duplicates is the sales team's call.
      if (email && !contactIdByEmail.has(email))
        contactIdByEmail.set(email, contact.Id);
    }

    const needCreate: IAccountSnapshot[] = [];
    for (const snapshot of snapshots) {
      const contactId = contactIdByEmail.get(snapshot.email.toLowerCase());
      if (!contactId) {
        needCreate.push(snapshot);
        continue;
      }

      snapshot.salesforceContactId = contactId;
      summary.matchedContacts += 1;
    }

    return needCreate;
  }

  /** Writes resolved lead Ids back to the admin users in one bulk operation. */
  private static async persistLeadIds(
    snapshots: IAccountSnapshot[],
  ): Promise<void> {
    const operations = snapshots
      .filter((snapshot) => snapshot.salesforceLeadId)
      .map((snapshot) => ({
        updateOne: {
          filter: { _id: ObjectId(snapshot.adminUserId) },
          update: { $set: { salesforceLeadId: snapshot.salesforceLeadId } },
        },
      }));

    if (operations.length) await User.bulkWrite(operations);
  }

  /** Stores the Contact Id resolved for admins whose lead has been converted. */
  private static async persistContactIds(
    snapshots: IAccountSnapshot[],
  ): Promise<void> {
    const operations = snapshots
      .filter((snapshot) => snapshot.salesforceContactId)
      .map((snapshot) => ({
        updateOne: {
          filter: { _id: ObjectId(snapshot.adminUserId) },
          update: {
            $set: { salesforceContactId: snapshot.salesforceContactId },
          },
        },
      }));

    if (operations.length) await User.bulkWrite(operations);
  }

  /**
   * Pushes snapshots onto their leads, keyed on the stored record Id — or onto the
   * Contact, for admins already known to have a converted lead. Writes go out in
   * SALESFORCE_PUSH_BATCH_SIZE-record requests (one at a time by default, so a
   * rejected record takes nothing else with it), and failures are collected rather
   * than thrown so one bad account can't stop the run.
   */
  public static async pushSnapshots(
    snapshots: IAccountSnapshot[],
    companyIds?: Types.ObjectId[],
  ): Promise<ISalesforceSyncSummary> {
    console.log(
      `SalesforceAccountSyncService.pushSnapshots: ${snapshots.length} snapshots`,
    );
    const startedAt = Date.now();

    // Active companies whose admin is missing or has no email never became
    // snapshots — surface them rather than letting them vanish from the totals.
    const companyFilter: Record<string, unknown> = {
      status: CURRENT_STATUS.ACTIVE,
    };
    if (companyIds?.length) companyFilter._id = { $in: companyIds };
    const activeCompanies = await Company.countDocuments(companyFilter);

    const { targets, duplicates } = this.dedupeByTargetId(snapshots);

    const summary: ISalesforceSyncSummary = {
      totalAccounts: activeCompanies,
      attempted: 0,
      updated: 0,
      failed: 0,
      skipped: Math.max(activeCompanies - targets.length - duplicates, 0),
      duplicateLeads: duplicates,
      updatedContacts: 0,
      contactIdsLinked: 0,
      staleIdsCleared: 0,
      failures: [],
      durationMs: 0,
    };

    const staleUserIds: string[] = [];
    // Leads Salesforce rejected as converted — retried against their Contact
    // after the lead pass, so one extra lookup covers the whole run.
    const converted: IAccountSnapshot[] = [];

    for (const batch of this.chunk(targets, SALESFORCE_PUSH_BATCH_SIZE)) {
      summary.attempted += batch.length;
      console.log(
        `SalesforceAccountSyncService.pushSnapshots: pushing batch of ${batch.length} snapshots`,
      );
      await this.pushBatch(batch, summary, staleUserIds, converted);
    }

    if (converted.length)
      await this.pushToConvertedContacts(converted, summary);

    if (staleUserIds.length) {
      await User.updateMany(
        { _id: { $in: staleUserIds.map((id) => ObjectId(id)) } },
        { $unset: { salesforceLeadId: "" } },
      );
      summary.staleIdsCleared = staleUserIds.length;
    }

    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  /**
   * Writes one batch and records each record's outcome.
   *
   * Salesforce returns per-record results for a valid request, but rejects the
   * whole collection with a 400 when any single record is malformed — an unknown
   * field, an unparseable date, a value past a field's length. So a 400 is retried
   * in halves until the offending record is alone and named in the failures, which
   * keeps a multi-record batch honest if SALESFORCE_PUSH_BATCH_SIZE is ever raised.
   * Any other error (auth, 5xx, network) is a genuine batch failure: retrying it
   * would just multiply the calls against an org that isn't answering.
   */
  private static async pushBatch(
    batch: IAccountSnapshot[],
    summary: ISalesforceSyncSummary,
    staleUserIds: string[],
    converted: IAccountSnapshot[],
  ): Promise<void> {
    try {
      const results = await SalesForceService.updateRecordsById(
        batch.map((snapshot) => this.toTargetRecord(snapshot)),
      );

      results.forEach((result, index) => {
        const snapshot = batch[index];
        if (result.success) {
          summary.updated += 1;
          if (snapshot.salesforceContactId) summary.updatedContacts += 1;
          return;
        }

        // Counted once the Contact retry has had its turn.
        if (this.isConvertedLeadError(result)) {
          converted.push(snapshot);
          return;
        }

        summary.failed += 1;
        summary.failures.push({
          companyId: snapshot.companyId,
          email: snapshot.email,
          message: this.describeErrors(result),
        });

        // The lead behind this Id is gone. Clearing it lets the next run
        // re-resolve or recreate instead of failing on it forever.
        if (this.isStaleIdError(result)) {
          staleUserIds.push(snapshot.adminUserId);
        }
      });
    } catch (error) {
      if (batch.length > 1 && SalesForceService.isBadRequest(error)) {
        const half = Math.ceil(batch.length / 2);
        await this.pushBatch(
          batch.slice(0, half),
          summary,
          staleUserIds,
          converted,
        );
        await this.pushBatch(
          batch.slice(half),
          summary,
          staleUserIds,
          converted,
        );
        return;
      }

      this.recordBatchFailure(summary.failures, batch, error);
      summary.failed += batch.length;
    }
  }

  /**
   * Retry path for leads the sales team already converted: Salesforce blocks every
   * write to such a lead and offers no API override, so the snapshot is pushed
   * onto the Contact the conversion produced. The Contact Id is stored on the
   * admin once a write to it succeeds, so later runs address it directly and stop
   * paying for the rejected lead attempt.
   */
  private static async pushToConvertedContacts(
    snapshots: IAccountSnapshot[],
    summary: ISalesforceSyncSummary,
  ): Promise<void> {
    for (const batch of this.chunk(
      snapshots,
      SALESFORCE_COMPOSITE_BATCH_SIZE,
    )) {
      const idList = batch
        .map(
          (snapshot) =>
            `'${SalesForceService.escapeSoql(snapshot.salesforceLeadId)}'`,
        )
        .join(",");

      let leads: ISalesforceLeadConversion[];
      try {
        leads = await SalesForceService.query<ISalesforceLeadConversion>(
          `SELECT Id, IsConverted, ConvertedContactId FROM Lead WHERE Id IN (${idList})`,
        );
      } catch (error) {
        this.recordBatchFailure(summary.failures, batch, error);
        summary.failed += batch.length;
        continue;
      }

      const contactIdByLeadId = new Map<string, string>();
      for (const lead of leads) {
        if (lead.ConvertedContactId)
          contactIdByLeadId.set(lead.Id, lead.ConvertedContactId);
      }

      const targets: IAccountSnapshot[] = [];
      const claimedContactIds = new Set<string>();

      for (const snapshot of batch) {
        const contactId = contactIdByLeadId.get(snapshot.salesforceLeadId);

        // Converted with no Contact behind it (converted to an Account only, or
        // the Contact was since merged away) — there is nothing writable left.
        if (!contactId) {
          summary.failed += 1;
          summary.failures.push({
            companyId: snapshot.companyId,
            email: snapshot.email,
            message: `${SALESFORCE_CONVERTED_LEAD_ERROR}: lead ${snapshot.salesforceLeadId} has no converted Contact to update`,
          });
          continue;
        }

        // Two leads can converge on one Contact; a composite batch may not carry
        // the same Id twice, so the extras are reported like lead duplicates.
        if (claimedContactIds.has(contactId)) {
          summary.duplicateLeads += 1;
          continue;
        }

        claimedContactIds.add(contactId);
        snapshot.salesforceContactId = contactId;
        targets.push(snapshot);
      }

      if (!targets.length) continue;
      summary.contactIdsLinked += targets.length;

      // The Id lookup above is a single read for the whole batch, but the writes
      // go out at SALESFORCE_PUSH_BATCH_SIZE like every other write.
      const written: IAccountSnapshot[] = [];
      for (const chunk of this.chunk(targets, SALESFORCE_PUSH_BATCH_SIZE)) {
        try {
          const results = await SalesForceService.updateRecordsById(
            chunk.map((snapshot) => this.toContactRecord(snapshot)),
          );
          results.forEach((result, index) => {
            const snapshot = chunk[index];
            if (result.success) {
              summary.updated += 1;
              summary.updatedContacts += 1;
              written.push(snapshot);
              return;
            }
            summary.failed += 1;
            summary.failures.push({
              companyId: snapshot.companyId,
              email: snapshot.email,
              message: `Contact ${snapshot.salesforceContactId}: ${this.describeErrors(result)}`,
            });
          });
        } catch (error) {
          this.recordBatchFailure(summary.failures, chunk, error);
          summary.failed += chunk.length;
        }
      }

      // Only Ids that were actually written are stored — a Contact that rejected
      // the snapshot gets re-resolved next run instead of silently locking the
      // account onto a target the sync can't write to.
      await this.persistContactIds(written);
    }
  }

  /**
   * A lead Id lives on the admin user, but usage is per company, so an admin who
   * owns two companies yields two snapshots pointing at one record. Salesforce
   * rejects a composite batch containing the same Id twice, so the most recently
   * active company wins and the rest are reported as duplicates.
   */
  private static dedupeByTargetId(snapshots: IAccountSnapshot[]): {
    targets: IAccountSnapshot[];
    duplicates: number;
  } {
    const byTargetId = new Map<string, IAccountSnapshot>();
    let duplicates = 0;

    for (const snapshot of snapshots) {
      // Contact wins: once the lead is converted it's the only writable record.
      const targetId =
        snapshot.salesforceContactId || snapshot.salesforceLeadId;
      if (!targetId) continue;

      const current = byTargetId.get(targetId);
      if (!current) {
        byTargetId.set(targetId, snapshot);
        continue;
      }

      duplicates += 1;
      const currentActivity = current.lastActivity?.getTime() || 0;
      const candidateActivity = snapshot.lastActivity?.getTime() || 0;
      if (candidateActivity > currentActivity) {
        byTargetId.set(targetId, snapshot);
      }
    }

    return { targets: Array.from(byTargetId.values()), duplicates };
  }

  private static isConvertedLeadError(
    result: ISalesforceCompositeResult,
  ): boolean {
    return (result.errors || []).some(
      (error) => error.statusCode === SALESFORCE_CONVERTED_LEAD_ERROR,
    );
  }

  private static isStaleIdError(result: ISalesforceCompositeResult): boolean {
    return (result.errors || []).some((error) =>
      SALESFORCE_STALE_ID_ERRORS.includes(error.statusCode),
    );
  }

  private static recordBatchFailure(
    failures: ISyncFailure[],
    batch: IAccountSnapshot[],
    error: unknown,
  ): void {
    // Salesforce's own error code and message, not axios's "status code 400".
    const message = SalesForceService.describeError(error);
    for (const snapshot of batch) {
      failures.push({
        companyId: snapshot.companyId,
        email: snapshot.email,
        message,
      });
    }
  }
}
