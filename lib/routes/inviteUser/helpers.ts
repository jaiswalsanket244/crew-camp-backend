import { Types } from "mongoose";
import { InvitedUsers } from "../../db";
export class InviteUsersHelpers {
  public static inviteUsers = async (
    role: string,
    companyId: Types.ObjectId,
    userId: string,
    projectId?: Types.ObjectId,
  ) => {
    const invitation = {
      companyId,
      userId,
      role,
    };

    if (projectId) {
      invitation["projectId"] = projectId;
    }

    const invite = await InvitedUsers.create(invitation);

    return invite._id;
  };

  public static validateInvite = (inviteCode: string, createdAt: Date) => {
    return InvitedUsers.findOne(
      { _id: inviteCode, status: "PENDING", createdAt: { $gt: createdAt } },
      { companyId: 1, projectId: 1, role: 1 },
    );
  };

  public static getInviteData = async (inviteCode: string) => {
    const invite = await InvitedUsers.findOne(
      { _id: inviteCode, status: "PENDING" },
      { companyId: 1 },
    );

    return invite;
  };

  public static addProjectIdToInvite = (
    inviteCode: string,
    projectId: Types.ObjectId,
  ) => {
    return InvitedUsers.findByIdAndUpdate(inviteCode, {
      $set: {
        projectId,
      },
    });
  };
}
