// NPM Dependencies
import { User } from "../../../db";
import { ObjectIdType } from "../../../utils/interfaces/schemaInterface";
export class UsersHelpers {
  public static findOne = async (id: ObjectIdType) => {
    return User.findById(id);
  };

  public static findAndUpdate = async (
    id: string,
    update: any,
    options?: any,
  ) => {
    return User.findByIdAndUpdate(id, update, options);
  };

  public static renewSubscription = async ({ id, endDate }) => {
    return User.findByIdAndUpdate(
      id,
      { subscriptionActiveUntil: endDate, subscriptionStatus: "ACTIVE" },
      { new: true, context: "query" },
    );
  };
  public static cancelSubscription = async (id) => {
    return User.findByIdAndUpdate(
      id,
      { subscriptionStatus: "INACTIVE" },
      { new: true },
    );
  };
}
