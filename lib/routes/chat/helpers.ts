import { User } from "./../../db/index";
import { ObjectId } from "../../utils/helpers/commonHelper";
export class ChatHelpers {
  public static searchUser = async (email: string) => {
    return User.aggregate([
      {
        $match: {
          email,
        },
      },
      {
        $project: {
          _id: 1,
          name: 1,
          email: 1,
        },
      },
    ]);
  };

  public static findUserInfo = async (userId: string) => {
    return User.aggregate([
      {
        $match: {
          _id: ObjectId(userId),
        },
      },
      {
        $project: {
          name: 1,
          _id: 0,
        },
      },
    ]);
  };
}
