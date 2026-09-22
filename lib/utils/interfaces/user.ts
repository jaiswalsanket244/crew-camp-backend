import { SORT_TYPE } from "../enums/post";
import { ObjectIdType } from "./schemaInterface";

export interface IUserSettings {
  userId: ObjectIdType;
  homePageView: {
    sortBy: SORT_TYPE;
  };
}
