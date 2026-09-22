import { Types } from "mongoose";
import { CURRENT_COMPANY_MEMBER_STATUS } from "../enums/enums";

export interface ICompanyMembership {
  _id: Types.ObjectId;
  companyId: Types.ObjectId;
  userId: Types.ObjectId;
  role: string;
  status: CURRENT_COMPANY_MEMBER_STATUS;
  deactivatedAt?: Date;
  deactivatedBy?: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IMemberStateChangePayload {
  userId: string;
}

// Result of resolving whether a user is locked out because their only company
// membership was deactivated.
export interface IDeactivationCheck {
  isDeactivated: boolean;
  companyName?: string;
}

export interface IMemberStateGuardError {
  statusCode: number;
  message: string;
}

// Outcome of the shared permission guard behind deactivate / re-enable: either
// `error` is set, or `companyId` and `membership` are.
export interface IMemberStateGuardResult {
  error?: IMemberStateGuardError;
  companyId?: Types.ObjectId;
  membership?: ICompanyMembership;
}

export interface ISeatAvailability {
  maxAllowedUsers: number;
  activeMembersCount: number;
  hasSeatAvailable: boolean;
}
