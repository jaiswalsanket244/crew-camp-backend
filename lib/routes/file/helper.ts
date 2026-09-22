import { isValidObjectId } from "mongoose";
import { Files } from "../../db";
import {
  IFileCreate,
  IFilesDeletedFetchQuery,
  IFilesFetchQuery,
  IFileUpdate,
} from "../../utils/interfaces/files";
import { getUserNamePipeline } from "../../utils/helpers/commonHelper";
import { CURRENT_STATUS, USER_ROLE } from "../../utils/enums/enums";
import { FileAccessType } from "../../utils/enums/files";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

export class FilesHelper {
  public static create = async (payload: IFileCreate) => {
    return Files.create(payload);
  };

  public static getFilesByProject = async (
    companyId: ObjectIdType,
    projectId: ObjectIdType,
    userId: ObjectIdType,
    userRole: USER_ROLE,
    search?: string,
    limit?: number,
  ) => {
    let query: IFilesFetchQuery = {
      companyId,
      status: { $ne: CURRENT_STATUS.DELETED },
    };

    if (projectId && isValidObjectId(projectId)) {
      query = { ...query, projectId };
    }

    if (userRole == USER_ROLE.STANDARD) {
      query["$or"] = [{ userId }, { accessLevel: FileAccessType.PUBLIC }];
    }

    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const userNamePipeline = getUserNamePipeline();

    const pipeline: any[] = [
      {
        $match: query,
      },
      ...userNamePipeline,
      {
        $sort: {
          createdAt: -1 as -1,
        },
      },
      {
        $project: {
          name: 1,
          size: 1,
          fileType: 1,
          url: 1,
          userId: 1,
          createdAt: 1,
          userName: 1,
          profileImage: 1,
          accessLevel: 1,
        },
      },
    ];

    if (limit) {
      pipeline.push({ $limit: limit });
    }

    return Files.aggregate(pipeline);
  };

  // Tab badge count for Files. Mirrors getFilesByProject's scoping exactly,
  // including role-based visibility (STANDARD users only see own + PUBLIC files),
  // so the badge matches the Files tab and never leaks restricted-file existence.
  public static countByProject = (
    companyId: ObjectIdType,
    projectId: ObjectIdType,
    userId: ObjectIdType,
    userRole: USER_ROLE,
  ) => {
    let query: IFilesFetchQuery = {
      companyId,
      status: { $ne: CURRENT_STATUS.DELETED },
    };

    if (projectId && isValidObjectId(projectId)) {
      query = { ...query, projectId };
    }

    if (userRole == USER_ROLE.STANDARD) {
      query["$or"] = [{ userId }, { accessLevel: FileAccessType.PUBLIC }];
    }

    return Files.countDocuments(query);
  };

  public static fetchCurrentCapacity = async (companyId: ObjectIdType) => {
    const pipeline = [
      {
        $match: { companyId: companyId },
      },
      {
        $group: {
          _id: null,
          size: { $sum: "$size" },
        },
      },
    ];
    return Files.aggregate(pipeline);
  };

  public static update = async (fileId: ObjectIdType, payload: IFileUpdate) => {
    return Files.findByIdAndUpdate(fileId, { $set: payload });
  };

  public static delete = async (fileId: ObjectIdType) => {
    return Files.findByIdAndUpdate(fileId, {
      $set: { status: CURRENT_STATUS.DELETED },
    });
  };

  public static getDeletedFiles = async (
    companyId: ObjectIdType,
    userId: ObjectIdType,
    userRole: USER_ROLE,
  ) => {
    const query: IFilesDeletedFetchQuery = {
      companyId,
      status: CURRENT_STATUS.DELETED,
      // Excludes files binned along with their project.
      preDeleteStatus: { $exists: false },
    };

    if (userRole == USER_ROLE.STANDARD) {
      query["$or"] = [{ userId }, { accessLevel: FileAccessType.PUBLIC }];
    }

    const userNamePipeline = getUserNamePipeline();

    const pipeline = [
      {
        $match: query,
      },
      ...userNamePipeline,
      {
        $sort: {
          updatedAt: -1 as -1,
        },
      },
      {
        $project: {
          name: 1,
          size: 1,
          fileType: 1,
          url: 1,
          userId: 1,
          createdAt: 1,
          userName: 1,
          profileImage: 1,
          accessLevel: 1,
        },
      },
    ];
    return Files.aggregate(pipeline);
  };

  public static restoreDeletedFile = async (fileId: ObjectIdType) => {
    return Files.findByIdAndUpdate(fileId, {
      $set: { status: CURRENT_STATUS.ACTIVE },
    });
  };
}
