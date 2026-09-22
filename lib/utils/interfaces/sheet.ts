import { ObjectIdType } from "./schemaInterface";
import { IDailyLogPhoto, RichTextDoc } from "./dailyLog";
import { SHEET_STATUS } from "../enums/sheet";

export interface ISheetInput {
  projectId: string;
  schemaVersion: number;
  title: string;
  projectName: string;
  projectAddress: string;
  bodyDoc: RichTextDoc | null;
  bodyText: string;
  photos: IDailyLogPhoto[];
}

export interface ISheetCreatePayload extends ISheetInput {
  companyId: ObjectIdType;
  userId: ObjectIdType;
}

export interface ISheetDocument extends Omit<ISheetInput, "projectId"> {
  _id: ObjectIdType;
  projectId: ObjectIdType;
  companyId: ObjectIdType;
  userId: ObjectIdType;
  status: SHEET_STATUS;
  createdAt: Date;
  updatedAt: Date;
}
