import { InvitedUsers } from "../../../db";
import { EmailService } from "../../../services/email";
import { config } from "../../../utils/configuration/config";
import {
  createFacetPipeline,
  generateTokenForAuth,
} from "../../../utils/helpers/commonHelper";
import { UserType } from "../../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

export class InviteUsersHelpers {
  public static async findAllInvitedUser(
    query: PaginatedSearchQuery,
    user: UserType,
  ) {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 15;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;

    const matchQuery = { companyId: user.companyId };

    if (searchValue) {
      matchQuery["$match"] = { $text: { $search: searchValue } };
    }
    const facetPipeline = createFacetPipeline(page, skips, limit);

    return InvitedUsers.aggregate([{ $match: matchQuery }, ...facetPipeline]);
  }

  public static inviteUsers = async (
    emails: { email: string; role: string }[],
    companyId: string,
    userId: string,
  ) => {
    const emailService = new EmailService();

    const alreadyInvitedEmails = [];
    const createInvitations = [];

    for (const emailObj of emails) {
      const existingInvitation = await InvitedUsers.findOne({
        invitedEmail: emailObj.email,
      });

      if (existingInvitation) {
        alreadyInvitedEmails.push(emailObj.email);
      } else {
        const invitation = {
          invitedEmail: emailObj.email,
          companyId,
          userId,
          role: emailObj.role,
        };

        createInvitations.push(InvitedUsers.create(invitation));
        const token = generateTokenForAuth(emailObj.email);
        const link = `${config.FRONTEND_INVITE_URL}/${token}`;
        emailService.inviteUserEmail({ email: emailObj.email, link });
      }
    }

    await Promise.all(createInvitations);

    return {
      message: `Mail with invite sent successfully ${
        alreadyInvitedEmails.length > 0
          ? `except for ${alreadyInvitedEmails.join(
              ", ",
            )} as they are already invited`
          : ""
      }`,
    };
  };
}
