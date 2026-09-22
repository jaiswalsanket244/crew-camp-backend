import * as status from "http-status";
import { Response } from "express";
import { Types } from "mongoose";
import { CompanyHelpers } from "../../routes/company/helpers";
import { ErrorResponse } from "./apiResponse";
import {
  ACCOUNT_DEACTIVATED_CODE,
  ACCOUNT_DEACTIVATED_MESSAGE,
} from "../constants/constants";

/**
 * A user is locked out when an admin/manager deactivated their company
 * membership and they hold no active membership anywhere. Users with no
 * membership at all (mid-signup, pre-invite) are not locked out.
 */
export const isAccountDeactivated = async (
  userId: Types.ObjectId | string,
): Promise<boolean> => {
  if (!userId) return false;

  const lockedOutMembership =
    await CompanyHelpers.getLockedOutMembership(userId);

  return Boolean(lockedOutMembership);
};

export const AccountDeactivatedResponse = (res: Response) => {
  return ErrorResponse(res, status.FORBIDDEN, {
    message: ACCOUNT_DEACTIVATED_MESSAGE,
    errors: { code: ACCOUNT_DEACTIVATED_CODE },
  });
};
