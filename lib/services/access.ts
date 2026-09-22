import { USER_ROLE } from "../utils/enums/enums";
import { ObjectIdType } from "../utils/interfaces/schemaInterface";

export class AccessServices {
  public static isManagerOrAbove = (role: string) => {
    return role === USER_ROLE.ADMIN || role === USER_ROLE.MANAGER;
  };

  public static isSelfOrManagerOrAbove = (
    role: string,
    userId: ObjectIdType,
    creatorId: ObjectIdType,
  ) => {
    return (
      this.isManagerOrAbove(role) || userId.toString() === creatorId.toString()
    );
  };
}
