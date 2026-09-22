import { Types } from "mongoose";
import { NotificationCategory, NotificationMessageKey } from "../enums/enums";
import { NotificationMessageParams } from "./i18n";
import { NotificationPreferences } from "./notificationPreferences";
import {
  CHECKLIST_STATUS,
  CHECKLIST_TYPE,
  FIELD_TYPE,
} from "../enums/checklist";

type ObjectId = Types.ObjectId;
export interface CompanyType {
  name?: string;
  userId?: string;
  status?: string;
  website?: string;
}

export interface RefundType {
  chargeId?: string;
  status?: string;
  created?: number;
  refundId?: string;
  amount?: number;
  reason?: string;
  paymentId?: string;
  refundedAmount?: number;
  currency?: string;
  user?: string;
}

export interface RefundData {
  user?: string;
  paymentId?: string;
  charge?: string;
  status?: string;
  created?: number;
  id?: string;
  reason?: string;
  amount?: number;
  currency?: string;
}

export interface FcmTokenType {
  userId?: ObjectId;
  deviceType?: string;
  deviceId?: string;
  token?: string;
  isDeleted?: boolean;
}

export interface ProductType {
  title?: string;
  productImages?: string[];
  description?: string;
  price?: number;
  costPrice?: number;
  retailPrice?: number;
  salePrice?: number;
  createdBy?: ObjectId;
  sellerStripeAccountId?: string;
}

export interface CompaniesType {
  companyId: ObjectIdType;
  role: string;
}

export interface UserType {
  email: string;
  name: {
    first: string;
    last: string;
  };
  roles: string;
  referralCode: string;
  companyId: Types.ObjectId;
  companies?: CompaniesType[];
  _id: Types.ObjectId;
  stripeCustomerId?: string;
  fullName?: string;
  stripeAccountId?: string;
  subscriptionCancellationRequested?: boolean;
  adminId: Types.ObjectId;
  notificationPreferences?: Partial<NotificationPreferences>;
}

export interface SubscriptionType {
  userRef?: ObjectId;
  planId?: string;
  planName?: string;
  price?: number;
  currentPeriodStarts?: number;
  currentPeriodEnds?: number;
  subscriptionId?: string;
  subscriptionCancellationRequested?: boolean;
  status?: string;
  subscriptionPlanRef?: ObjectId;
}

export interface UpdatePlanType {
  name: string;
  description: string;
  image: string;
  productId: string;
}

export interface OrderType {
  productId?: ObjectId;
  chargeId?: ObjectId;
  userId?: ObjectId;
  paymentStatus?: string;
}

export interface NotificationType {
  userId: ObjectId;
  message: string;
  messageKey?: NotificationMessageKey;
  messageParams?: NotificationMessageParams;
  createdBy: ObjectId;
  projectId?: ObjectId;
  postId?: ObjectId;
  taskId?: ObjectId;
  url?: string;
  isOpened?: boolean;
  category?: NotificationCategory;
}

export interface SubscriptionPlanType {
  price?: number;
  title?: string;
  type?: string;
  currency?: string;
  priceId?: string;
  status?: string;
  description?: string;
  image?: string;
  productId?: string;
}

export interface CommentType {
  userId: ObjectId;
  projectId?: string;
  postId?: ObjectId;
  fileId?: string;
  commentId?: string;
  projectNoteId?: string;
  comment?: string;
  fileUrl?: string;
  fileSize?: {
    width: string;
    height: string;
  };
  mentions?: Types.ObjectId[];
}

export interface ProjectType {
  name: string;
  projectImage?: string;
  location: string;
  description: string;
  tags?: string[];
  coordinates?: {
    latitude?: number;
    longitude: number;
  };
}
export interface ProjectMemberType {
  projectId: ObjectId;
  userId: ObjectId;
  status: string;
  type?: string;
}

export interface ProjectNotesType {
  projectId: Types.ObjectId;
  note: string;
  userId: Types.ObjectId;
  files?: {
    url: string;
    size?: {
      width?: number;
      height?: number;
    };
  }[];
}

export interface ProjectTaskType {
  projectId: string;
  name: string;
  description: string;
  severity: string;
  assignedTo: string[];
  taskImage?: string;
}

export interface SelectOptionType {
  label: string;
  value: string;
}

// Type-specific config for a field definition. All keys optional at the type
// level; shape is enforced per-fieldType in the validation helper, not here.
export interface FieldConfigType {
  placeholder?: string;
  multiline?: boolean;
  allowNA?: boolean;
  maxRating?: number;
  options?: SelectOptionType[];
  minSelections?: number;
  maxSelections?: number;
  unit?: string;
  min?: number;
  max?: number;
  decimalPlaces?: number;
}

export type FieldResponseValue = boolean | string | number | string[] | null;

export interface FieldDefinitionType {
  _id?: ObjectId | string;
  fieldType: FIELD_TYPE;
  label: string;
  required?: boolean;
  sortOrder?: number;
  config?: FieldConfigType;
}

export interface FieldResponseType {
  _id?: ObjectId | string;
  fieldId: ObjectId | string;
  fieldType: FIELD_TYPE;
  value: FieldResponseValue;
  updatedBy?: ObjectId | string | null;
  updatedAt?: Date | string;
}

export interface TodoType {
  name: string;
  description?: string;
  questions?: { label: string; value: string; _id?: ObjectId | string }[];
  sortOrder: number;
  checklistId: ObjectId;
  areImagesMandatory: boolean;
  status?: string;
  completedBy?: ObjectId | null;
  completedAt?: Date | null;
  postId?: ObjectId | null;
  taskImages?: {
    imageData: {
      url: string;
      fileType: string;
      size: { width: number; height: number };
    };
  }[];
  fields?: FieldDefinitionType[];
  responses?: FieldResponseType[];
}

export interface TodoResponseType extends TodoType {
  _id: ObjectId;
}

export interface ChecklistType {
  _id: ObjectId;
  name: string;
  projectId: ObjectId;
  companyId: ObjectId;
  contributors: ObjectId[];
  todoList: TodoType[];
}

// V2 create/update task payload — API surface uses `photosRequired`,
// which ChecklistHelper maps to the stored `areImagesMandatory`.
export interface TaskV2PayloadType {
  _id?: ObjectId | string;
  name: string;
  description?: string;
  sortOrder?: number;
  photosRequired?: boolean;
  taskImages?: {
    imageData: {
      url: string;
      fileType: string;
      size: { width: number; height: number };
    };
  }[];
  fields?: FieldDefinitionType[];
  attachments?: {
    url: string;
    fileType: string;
    size?: { width: number; height: number };
    uploadedAt?: Date | string;
    // Uploader attribution round-tripped from details/v3 so a replace-semantics
    // update keeps each photo's original owner (CRE-707).
    userId?: ObjectId | string | null;
    uploadedBy?: { _id?: ObjectId | string | null } | null;
  }[];
}

export interface CreateChecklistV2Type {
  name: string;
  projectId: ObjectId | string;
  companyId?: ObjectId | string;
  contributors?: (ObjectId | string)[];
  tasks?: TaskV2PayloadType[];
}

export interface UpdateChecklistV2Type {
  checklistId: ObjectId | string;
  name?: string;
  contributors?: (ObjectId | string)[];
  tasks?: TaskV2PayloadType[];
}

export interface SaveFieldResponsePayload {
  checklistId: string;
  todoListId: string;
  fieldId: string;
  fieldType: FIELD_TYPE;
  value: FieldResponseValue;
}

export type ObjectIdType = Types.ObjectId;

export interface TodoStatusQuery {
  status: string;
  completedBy?: ObjectId | null;
  completedAt?: Date | null;
}

// Mongo $match filter built by getChecklistsV2 and consumed by
// ChecklistHelper.findMyChecklists.
export interface FindMyChecklistsPayload {
  type: CHECKLIST_TYPE;
  status: { $ne: CHECKLIST_STATUS };
  companyId: ObjectId | string;
  projectId?: ObjectId | { $in: ObjectId[] };
  name?: { $regex: string; $options: string };
}

// Pagination values derived from the request query for findMyChecklists.
export interface FindMyChecklistsQuery {
  page: number;
  limit: number;
  skip: number;
}

export interface MyChecklistContributor {
  _id: ObjectId;
  userName: string;
  profileImage?: string;
}

export interface MyChecklistType {
  _id: ObjectId;
  name: string;
  userName?: string;
  contributors: MyChecklistContributor[];
  totalTodo?: number;
  completedTodo?: number;
  createdAt: Date;
  projectId: ObjectId;
  projectName?: string;
}

export interface ChecklistIdQuery {
  checklistId: string;
}

export interface ReportType {
  postId: string;
  reason: string;
  description?: string;
  url?: string;
  userId: Types.ObjectId;
}
