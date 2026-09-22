import { ObjectIdType } from "./schemaInterface";

export interface IPreReportData {
  companyId?: ObjectIdType;
  projectId: ObjectIdType;
  userId?: ObjectIdType;
  reportName: string;
  photosPerPage: number;
  showCoverPage: boolean;
  showCoverPageImage: boolean;
  coverPageImage: string;
  showCompanyName: boolean;
  showCreatedBy: boolean;
  showCreatedAt: boolean;
  showPageCount: boolean;
  reportSource?: string;
}

export interface IPreSectiondata {
  reportId?: ObjectIdType;
  sectionName: string;
  sectionDescription: string;
  order: number;
}
export interface IPreSubSectionData {
  sectionId: string | ObjectIdType;
  order: number;
  description: string;
  image?: string;
  subSectionName?: string;
  uploadData?: IImageUploadData;
  userId?: ObjectIdType;
}

export interface IImageUploadData {
  uploadedBy?: string;
  uploadedAt?: string;
}

export interface IReportReponse {
  _id: ObjectIdType;
  reportName: string;
  projectId: ObjectIdType;
  companyId?: ObjectIdType;
  projectName?: string;
  userId?: ObjectIdType;
  photosPerPage: number;
  reportSource?: string;
  showCoverPage: boolean;
  showCoverPageImage: boolean;
  coverPageImage?: string;
  showCompanyName: boolean;
  showCreatedBy: boolean;
  showCreatedAt: boolean;
  showPageCount: boolean;
  showCompanyLogo: boolean;
  companyLogo: string;
  sections: IReportSectionResponse[];
  webUrl: string;
  createdAt?: string;
  companyName?: string;
  createdBy?: string;
}

export interface IReportSectionResponse {
  _id: ObjectIdType;
  reportId: ObjectIdType;
  sectionName: string;
  sectionDescription: string;
  order: number;
  subSections?: IPreSubSectionData[];
}

export interface IProjectReportGetList {
  projectId: string;
  search: string;
  limit?: number;
}

// Personal View — cross-project "my reports": reports I created, in projects I
// am still a member of. projectIds (not companyId) is the scope, matching
// getAllList and GET /projectTasks/mine.
export interface IProjectReportGetMine {
  userId: string;
  projectIds: ObjectIdType[];
  search?: string;
  limit?: number;
}

export interface IProjectReportGetListQuery {
  projectId: ObjectIdType;
  reportName?: { $regex: string; $options: "i" };
  status: { $ne: string };
}

export interface IReportSubSectionInput {
  subSectionName?: string;
  description: string;
  image?: string;
  uploadData?: IImageUploadData;
}

/** One section as supplied by a caller. */
export interface IReportSectionInput {
  sectionName: string;
  sectionDescription: string;
  subSections: IReportSubSectionInput[];
}
