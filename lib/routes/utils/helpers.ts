import { InvitedUsers } from "../../db";

export class UtilsHelpers {
  public static findSidebarItems = async (email: string) => {
    return InvitedUsers.findOne({ invitedEmail: email });
  };
}
