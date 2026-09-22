import { Types } from "mongoose";

export interface ICreateLead {
  FirstName: string;
  LastName: string;
  Company: string;
  Title: string;
  Email: string;
  Phone: string;
  LeadSource: string;
  Joined_On__c: string;
  // Stamped at creation so the nightly account sync can upsert on this external
  // ID instead of creating a duplicate lead. See SalesforceAccountSyncService.
  RelayCam_Org_ID__c?: string;
}

/** Shape returned by a `$group: { _id: "$companyId", count: { $sum: 1 } }` roll-up. */
export interface ICompanyCountRow {
  _id: Types.ObjectId | null;
  count: number;
}

/** Active-member count plus newest member activity, per company. */
export interface ICompanyMemberStatsRow {
  _id: Types.ObjectId | null;
  activeLicenses: number;
  lastActivity: Date | null;
}

/** Per-company usage roll-ups, each keyed by companyId string. */
export interface ICompanyUsageMaps {
  projectCounts: Map<string, number>;
  postCounts: Map<string, number>;
  postFileCounts: Map<string, number>;
  documentFileCounts: Map<string, number>;
  checklistCounts: Map<string, number>;
  reportCounts: Map<string, number>;
  aiActionCounts: Map<string, number>;
  guestProjectUserCounts: Map<string, number>;
  memberStats: Map<
    string,
    { activeLicenses: number; lastActivity: Date | null }
  >;
}

/** One admin account resolved into everything Salesforce needs. */
export interface IAccountSnapshot {
  companyId: string;
  adminUserId: string;
  /** Stored Salesforce Lead Id; empty until resolved or created. */
  salesforceLeadId: string;
  /**
   * Contact the lead was converted into. Once set it takes priority over the
   * lead Id, because Salesforce refuses every write to a converted lead.
   */
  salesforceContactId: string;
  companyName: string;
  joinedOn: Date;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  title: string;
  role: string;
  invitedBy: string;
  subscriptionStatus: string;
  subscriptionEnds: Date | null;
  purchaseMethod: string;
  stripeCustomerId: string;
  purchasedLicenses: number;
  activeLicenses: number;
  lastActivity: Date | null;
  projectCount: number;
  postCount: number;
  fileCount: number;
  checklistCount: number;
  reportCount: number;
  aiActionCount: number;
  guestProjectUsers: number;
}

/**
 * Snapshot fields carried by both the Lead and the Contact mapping — a converted
 * lead keeps reporting on identical field API names on its Contact.
 */
export interface ISalesforceSnapshotFields {
  RelayCam_Org_ID__c: string;
  FirstName?: string;
  LastName: string;
  Email?: string;
  Phone?: string;
  Title?: string;
  Role__c?: string;
  Invited_By__c?: string;
  Subscription_Status__c?: string;
  Purchased_Licenses__c?: number;
  Active_Licenses__c?: number;
  Subscription_Ends__c?: string;
  Purchase_Method__c?: string;
  Stripe_ID__c?: string;
  Joined_On__c?: string;
  Last_Activity__c?: string;
  Project_Count__c?: number;
  Post_Count__c?: number;
  File_Count__c?: number;
  Checklist_Count__c?: number;
  Report_Count__c?: number;
  AI_Actions_Count__c?: number;
  Guest_Project_Users__c?: number;
}

/** A Lead record in a Salesforce composite request body. */
export interface ISalesforceLeadRecord extends ISalesforceSnapshotFields {
  attributes: { type: "Lead" };
  id?: string;
  Company: string;
  LeadSource?: string;
}

/**
 * A Contact record in a composite request — where the snapshot goes once the lead
 * has been converted. `Company` is absent because a Contact takes its company
 * from the parent Account.
 */
export interface ISalesforceContactRecord extends ISalesforceSnapshotFields {
  attributes: { type: "Contact" };
  id: string;
}

/** Any record the sync can PATCH through /composite/sobjects. */
export type ISalesforceCompositeRecord =
  | ISalesforceLeadRecord
  | ISalesforceContactRecord;

/** Conversion state of a lead, read when a write is rejected as converted. */
export interface ISalesforceLeadConversion {
  Id: string;
  IsConverted: boolean;
  ConvertedContactId: string | null;
}

export interface ISalesforceError {
  statusCode: string;
  message: string;
  fields: string[];
}

/**
 * Body of a whole-request rejection (HTTP 4xx), which uses `errorCode` where the
 * per-record results use `statusCode`.
 */
export interface ISalesforceRequestError {
  errorCode?: string;
  statusCode?: string;
  message?: string;
  fields?: string[];
}

/** Per-record outcome from PATCH/POST /composite/sobjects. */
export interface ISalesforceCompositeResult {
  id: string | null;
  success: boolean;
  created?: boolean;
  errors: ISalesforceError[];
}

export interface ISalesforceQueryResponse<T> {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: T[];
}

/** Minimal Lead projection used when resolving a lead Id from an email. */
export interface ISalesforceLeadIdentity extends ISalesforceLeadConversion {
  Email: string | null;
}

/** Minimal Contact projection used when no lead exists for an email. */
export interface ISalesforceContactIdentity {
  Id: string;
  Email: string | null;
}

export interface ISyncFailure {
  companyId: string;
  email: string;
  message: string;
}

export interface ISalesforceSyncSummary {
  totalAccounts: number;
  attempted: number;
  updated: number;
  failed: number;
  /** Active companies with no admin email, or still without a lead Id. */
  skipped: number;
  /** Accounts sharing an admin's lead with another company (see dedupe note). */
  duplicateLeads: number;
  /** Updates that landed on a Contact because the lead had been converted. */
  updatedContacts: number;
  /** Leads found to be converted this run and linked to their Contact. */
  contactIdsLinked: number;
  /** Stored Ids that pointed at a deleted lead and were cleared for retry. */
  staleIdsCleared: number;
  failures: ISyncFailure[];
  durationMs: number;
}

/** Outcome of resolving lead Ids for admins that don't have one stored yet. */
export interface ILeadResolutionSummary {
  needingResolution: number;
  matchedByEmail: number;
  /** Admins with no lead of their own, linked to an existing Contact instead. */
  matchedContacts: number;
  createdLeads: number;
  failed: number;
  failures: ISyncFailure[];
}
