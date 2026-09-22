import { Types } from "mongoose";

import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

import {
  ProjectReports,
  ProjectReportsSection,
  ProjectReportsSubSection,
} from "../../db";
import {
  escapeRegExp,
  getUserNamePipeline,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import {
  IPreReportData,
  IReportSectionInput,
  IPreSectiondata,
  IPreSubSectionData,
  IProjectReportGetList,
  IProjectReportGetListQuery,
  IProjectReportGetMine,
  IReportSectionResponse,
} from "../../utils/interfaces/projectReports";
import { REPORT_STATUS } from "../../utils/enums/projectReports";
import { buildGlobalReportMatch } from "./listQuery";

type mongoId = Types.ObjectId;

// Bound on user-supplied search text before it reaches $regex — matches the cap
// the task and checklist list endpoints apply.
const SEARCH_MAX_LENGTH = 100;

export class ProjectReportsHelpers {
  public static createReport = (payload: IPreReportData) => {
    return ProjectReports.create(payload);
  };

  public static createSection = (payload: IPreSectiondata) => {
    return ProjectReportsSection.create(payload);
  };

  public static createSubSections = (payload: IPreSubSectionData[]) => {
    return ProjectReportsSubSection.insertMany(payload);
  };

  // Tab badge count for Reports. Mirrors getList's filter. NOTE: REPORT_STATUS
  // values are LOWERCASE ("active"/"deleted") unlike other status enums.
  public static countByProject = (projectId: string) => {
    return ProjectReports.countDocuments({
      projectId: ObjectId(projectId),
      status: { $ne: REPORT_STATUS.DELETED },
    });
  };

  public static createSectionsWithSubSections = async (
    reportId: mongoId,
    userId: ObjectIdType,
    sections: IReportSectionInput[],
  ): Promise<void> => {
    await Promise.all(
      sections.map(async (sectionData, sectionIndex) => {
        const section = await ProjectReportsHelpers.createSection({
          reportId,
          sectionName: sectionData.sectionName,
          sectionDescription: sectionData.sectionDescription,
          order: sectionIndex,
        });

        const subSections = (sectionData.subSections ?? []).map(
          (sub, order) => {
            const row: IPreSubSectionData = {
              sectionId: section._id,
              order,
              description: sub.description,
            };
            if (sub.image) {
              row.image = sub.image;
              row.uploadData = sub.uploadData;
              row.userId = userId;
            } else {
              row.subSectionName = sub.subSectionName;
            }
            return row;
          },
        );

        await ProjectReportsHelpers.createSubSections(subSections);
      }),
    );
  };

  public static getList = ({
    projectId,
    search,
    limit,
  }: IProjectReportGetList) => {
    const query: IProjectReportGetListQuery = {
      projectId: ObjectId(projectId),
      status: { $ne: REPORT_STATUS.DELETED },
    };

    if (search) {
      // Literal substring match (escaped + capped) — no regex injection / ReDoS.
      query.reportName = {
        $regex: escapeRegExp(String(search).slice(0, SEARCH_MAX_LENGTH)),
        $options: "i",
      };
    }

    const pipeline: any[] = [
      {
        $match: query,
      },
      {
        $project: {
          reportName: 1,
          createdAt: 1,
          updatedAt: 1,
          userId: 1,
        },
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
    ];

    if (limit) {
      pipeline.push({ $limit: limit });
    }

    return ProjectReports.aggregate(pipeline);
  };

  // Lightweight fetch used for authorization checks on mutate routes.
  // Returns only the fields needed to verify tenancy/membership.
  public static getReportById = (reportId: mongoId) => {
    return ProjectReports.findById(reportId, {
      companyId: 1,
      projectId: 1,
      status: 1,
    });
  };

  // Cross-project ("global") report list, scoped to the given member project
  // ids. Paginated via $facet so items + total come back in one round trip.
  // The $lookup runs AFTER $skip/$limit so it only joins the current page.
  public static getAllList = ({
    projectIds,
    search,
    page,
    limit,
  }: {
    projectIds: mongoId[];
    search?: string;
    page: number;
    limit: number;
  }) => {
    const query = buildGlobalReportMatch(projectIds, search);

    return ProjectReports.aggregate([
      { $match: query },
      // _id tiebreaker keeps pagination stable when updatedAt ties.
      { $sort: { updatedAt: -1, _id: -1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $lookup: {
                from: "projects",
                localField: "projectId",
                foreignField: "_id",
                as: "project",
              },
            },
            {
              $addFields: {
                projectName: { $arrayElemAt: ["$project.name", 0] },
                archivedAt: { $arrayElemAt: ["$project.archivedAt", 0] },
              },
            },
            {
              $project: {
                reportName: 1,
                userId: 1,
                projectId: 1,
                projectName: 1,
                archivedAt: 1,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          total: [{ $count: "count" }],
        },
      },
    ]);
  };

  // Personal View — reports I created, in projects I am still a member of.
  //
  // Shares getAllList's match builder and membership scope, so "mine" is that
  // list narrowed by userId rather than a second way to reach the same rows.
  // Scoping on projectId also keeps the query on the { projectId: 1 } index; a
  // companyId+userId match had none. Joins the project for projectName +
  // isProjectArchived; a deleted/missing project still yields a row (null
  // projectName) rather than dropping it.
  public static getMyReports = async ({
    userId,
    projectIds,
    search,
    limit,
  }: IProjectReportGetMine) => {
    // No active memberships means nothing can be "mine" — skip the round trip.
    if (!projectIds.length) return [];

    const query = {
      ...buildGlobalReportMatch(projectIds, search),
      userId: ObjectId(userId),
    };

    const pipeline: any[] = [
      {
        $match: query,
      },
      // _id tiebreaker keeps the "most recent N" slice deterministic when
      // updatedAt ties. $sort + $limit precede the $lookup so the projects join
      // only touches the rows actually returned.
      {
        $sort: {
          updatedAt: -1,
          _id: -1,
        },
      },
      ...(limit ? [{ $limit: limit }] : []),
      {
        $lookup: {
          from: "projects",
          localField: "projectId",
          foreignField: "_id",
          as: "projectData",
        },
      },
      {
        $project: {
          reportName: 1,
          projectId: 1,
          createdAt: 1,
          updatedAt: 1,
          reportSource: 1,
          projectName: { $arrayElemAt: ["$projectData.name", 0] },
          isProjectArchived: {
            $cond: [
              {
                $ne: [
                  {
                    $ifNull: [
                      { $arrayElemAt: ["$projectData.archivedAt", 0] },
                      null,
                    ],
                  },
                  null,
                ],
              },
              true,
              false,
            ],
          },
        },
      },
    ];

    return ProjectReports.aggregate(pipeline);
  };

  public static find = (reportId: mongoId) => {
    const userNamePipeline = getUserNamePipeline();
    return ProjectReports.aggregate([
      {
        $match: {
          _id: reportId,
        },
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "companies",
          localField: "companyId",
          foreignField: "_id",
          as: "companyData",
        },
      },
      {
        $lookup: {
          from: "projects",
          localField: "projectId",
          foreignField: "_id",
          as: "projectData",
        },
      },
    ]);
  };

  public static getReportSections = (
    reportId: mongoId,
  ): Promise<IReportSectionResponse[]> => {
    return ProjectReportsSection.aggregate([
      {
        $match: {
          reportId,
        },
      },
      {
        $sort: {
          order: 1,
        },
      },
    ]);
  };

  public static getReportSubSections = (sectionId: mongoId) => {
    return ProjectReportsSubSection.aggregate([
      {
        $match: {
          sectionId,
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userName",
        },
      },
      {
        $addFields: {
          userName: {
            $concat: [
              { $arrayElemAt: ["$userName.name.first", 0] },
              " ",
              { $arrayElemAt: ["$userName.name.last", 0] },
            ],
          },
        },
      },
      {
        $sort: {
          order: 1,
        },
      },
    ]);
  };

  public static moveToTrash = (reportId: mongoId) => {
    return ProjectReports.findByIdAndUpdate(reportId, {
      $set: { status: REPORT_STATUS.DELETED },
    });
  };

  public static delete = async (reportId: mongoId) => {
    const sections = await ProjectReportsSection.find({ reportId }, { _id: 1 });
    const sectionsIds = sections.map((s) => s._id);

    return Promise.all([
      ProjectReports.findByIdAndDelete(reportId),
      ProjectReportsSection.deleteMany({ reportId }),
      ProjectReportsSubSection.deleteMany({ sectionId: { $in: sectionsIds } }),
    ]);
  };

  public static updateReport = (reportId: mongoId, payload: IPreReportData) => {
    return ProjectReports.findByIdAndUpdate(reportId, { $set: payload });
  };

  public static updateSection = (
    sectionId: mongoId,
    payload: IPreSectiondata,
  ) => {
    return ProjectReportsSection.findByIdAndUpdate(sectionId, {
      $set: payload,
    });
  };

  public static findRemovedSections = (
    reportId: mongoId,
    sectionIds: mongoId[],
  ) => {
    return ProjectReportsSection.find(
      { reportId, _id: { $nin: sectionIds } },
      { _id: 1 },
    );
  };

  public static deleteSections = (reportId: mongoId, sectionIds: mongoId[]) => {
    return ProjectReportsSection.deleteMany({
      reportId,
      _id: { $in: sectionIds },
    });
  };

  public static deleteSubSectionsBySectionId = (
    sectionIds: mongoId[],
    subSectionIds: mongoId[],
  ) => {
    return ProjectReportsSubSection.deleteMany({
      sectionId: { $in: sectionIds },
      _id: { $nin: subSectionIds },
    });
  };

  public static updateSubSections = (
    subSectionId: mongoId,
    payload: IPreSubSectionData,
  ) => {
    return ProjectReportsSubSection.findByIdAndUpdate(subSectionId, {
      $set: payload,
    });
  };

  public static getDeletedReports = (companyId) => {
    const query = {
      companyId,
      status: REPORT_STATUS.DELETED,
      // Excludes reports binned along with their project.
      preDeleteStatus: { $exists: false },
    };

    return ProjectReports.aggregate([
      {
        $match: query,
      },
      {
        $project: {
          reportName: 1,
          createdAt: 1,
          updatedAt: 1,
          userId: 1,
        },
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
    ]);
  };

  public static restoreDeletedReport = (reportId: mongoId) => {
    return ProjectReports.findByIdAndUpdate(reportId, {
      $set: { status: REPORT_STATUS.ACTIVE },
    });
  };

  public static getReportSubSectionsWithImages = async (reportId: mongoId) => {
    const sections = await ProjectReportsSection.find({ reportId }, { _id: 1 });
    const sectionsIds = sections.map((s) => s._id);

    return ProjectReportsSubSection.find({
      sectionId: { $in: sectionsIds },
      image: { $exists: true },
      uploadData: { $exists: false },
    });
  };
}
