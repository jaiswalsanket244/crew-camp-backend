// NPM Dependencies
import * as status from "http-status";
import * as express from "express";

// Internal Dependencies
import { ProjectReportsHelpers } from "./helpers";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { Validator } from "node-input-validator";
import { isValidObjectId } from "mongoose";
import { ObjectId } from "../../utils/helpers/commonHelper";
import { config } from "../../utils/configuration/config";
import {
  IPreSubSectionData,
  IReportReponse,
  IReportSectionResponse,
} from "../../utils/interfaces/projectReports";
import { fileService } from "../../services/awsBucket";
import { ProjectHelper } from "../projects/helper";
import { normalizeReportListPaging, reportListPagination } from "./listQuery";

// GET /projectReports/mine is limit-only (no pagination yet), so the default
// bounds the payload when the client omits one; the app sends 100.
const MY_REPORTS_DEFAULT_LIMIT = 100;
const MY_REPORTS_MAX_LIMIT = 200;

export class ProjectReportsRoutes {
  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        id: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const reportId = req.params.id;

      if (!reportId || !isValidObjectId(reportId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Report Not found",
        });
      }

      const [response, sectionsData] = await Promise.all([
        ProjectReportsHelpers.find(ObjectId(reportId)),
        ProjectReportsHelpers.getReportSections(ObjectId(reportId)),
      ]);

      if (!response.length) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Report Not found",
        });
      }

      const sections = await Promise.all(
        sectionsData.map(async (section: IReportSectionResponse) => {
          const subSections = await ProjectReportsHelpers.getReportSubSections(
            section._id,
          );
          const subSectionsData = subSections.map((subSection) => {
            const sub = { ...subSection };
            if (subSection.image) {
              sub.image = fileService.convertToS3BucketLink(subSection.image);
            }
            return sub;
          });
          const obj = {
            ...section,
            subSections: subSectionsData,
          };
          return obj;
        }),
      );

      const report = response[0];

      const data: IReportReponse = {
        _id: report._id,
        reportName: report.reportName,
        projectId: report.projectId,
        photosPerPage: report.photosPerPage,
        reportSource: report.reportSource,
        showCoverPage: report.showCoverPage,
        sections,
        webUrl: `${config.WEB_URL}/report/${report._id}`,
        showCoverPageImage: false,
        showCompanyName: false,
        showCreatedBy: false,
        showCreatedAt: false,
        showPageCount: false,
        projectName: report.projectData?.[0]?.name,
        showCompanyLogo: false,
        companyLogo: "",
      };

      if (report.showCoverPage) {
        if (report.showCoverPageImage) {
          data.showCoverPageImage = report.showCoverPageImage;
          data.coverPageImage = fileService.convertToS3BucketLink(
            report.coverPageImage,
          );
        }

        if (report.showPageCount) {
          data.showPageCount = report.showPageCount;
        }

        if (report.showCreatedAt) {
          data.showCreatedAt = report.showCreatedAt;
          data.createdAt = report.createdAt;
        }

        if (report.showCreatedBy) {
          data.showCreatedBy = report.showCreatedBy;
          data.createdBy = report?.userName;
        }

        if (report.showCompanyName) {
          data.showCompanyName = report.showCompanyName;
          data.companyName = report?.companyData?.[0]?.name;
        }
        if (report.showCompanyLogo && report?.companyData?.[0]?.companyLogo) {
          data.showCompanyLogo = report.showCompanyLogo;
          data.companyLogo = report.companyData[0].companyLogo;
        }
      }

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const {
        projectId,
        reportName,
        photosPerPage,
        showCoverPage,
        showCoverPageImage,
        coverPageImage,
        showCompanyName,
        showCreatedBy,
        showCreatedAt,
        showPageCount,
        showCompanyLogo,
        sections,
        reportSource,
      } = req.body;
      const user = req.user;

      const reportPayload = {
        companyId: user.companyId,
        projectId,
        userId: user._id,
        reportName,
        photosPerPage,
        showCoverPage,
        showCoverPageImage,
        coverPageImage,
        showCompanyName,
        showCreatedBy,
        showCreatedAt,
        showPageCount,
        showCompanyLogo,
        reportSource,
      };

      const report = await ProjectReportsHelpers.createReport(reportPayload);

      await ProjectReportsHelpers.createSectionsWithSubSections(
        report._id,
        req.user._id,
        sections,
      );

      ProjectHelper.updateProjectInfo(report.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Report Created Successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getReportList = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        projectId: "required|string",
        search: "string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const { projectId } = req.query;

      if (!projectId || !isValidObjectId(projectId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
        });
      }

      const limit = req.query.limit
        ? parseInt(req.query.limit as string, 10)
        : undefined;

      const [list, totalCounts] = await Promise.all([
        ProjectReportsHelpers.getList({ ...req.query, limit }),
        ProjectReportsHelpers.countByProject(projectId),
      ]);

      const data = list.map((report) => ({
        ...report,
        webUrl: `${config.WEB_URL}/report/${report._id}`,
      }));

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data,
        totalCounts,
      });
    } catch (error) {
      next(error);
    }
  };

  // Cross-project ("global") report list for the authenticated user, scoped to
  // the projects they are a member of. Paginated + searchable. Must be mounted
  // AFTER authMiddleware (it relies on req.user).
  public static getAllList = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { page, limit } = normalizeReportListPaging(
        req.query as { page?: string; limit?: string },
      );
      const search = req.query.search as string | undefined;

      const projectIds = await ProjectHelper.getMyProjects(req.user._id);

      if (!projectIds.length) {
        return SuccessResponse(res, status.OK, {
          message: "Success.",
          data: { data: [], pagination: reportListPagination(0, limit) },
        });
      }

      const [result] = await ProjectReportsHelpers.getAllList({
        projectIds,
        search,
        page,
        limit,
      });

      const total = result?.total?.[0]?.count || 0;
      const data = (result?.items || []).map((report) => ({
        ...report,
        webUrl: `${config.WEB_URL}/report/${report._id}`,
      }));

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: {
          data,
          pagination: reportListPagination(total, limit),
        },
      });
    } catch (error) {
      next(error);
    }
  };

  // Personal View — GET /projectReports/mine (authenticated).
  // Reports the current user created, across the projects they are still an
  // active member of.
  public static getMyReports = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        search: "string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      // Bound limit: a non-positive value makes Mongo's $limit throw (→ 500),
      // so junk falls back to the default rather than propagating. Defaulted
      // (not left open) so an omitted limit can't return the caller's entire
      // report history — same posture as the task and checklist "mine" routes.
      const rawLimit = parseInt(req.query.limit as string, 10);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, MY_REPORTS_MAX_LIMIT)
          : MY_REPORTS_DEFAULT_LIMIT;

      // Authorization scope: authorship only counts inside projects the caller
      // is still an active member of — same boundary as /list/all above and
      // GET /projectTasks/mine.
      const projectIds = await ProjectHelper.getMyProjects(req.user._id);

      const list = await ProjectReportsHelpers.getMyReports({
        userId: req.user._id,
        projectIds,
        search: req.query.search,
        limit,
      });

      const data = list.map((report) => ({
        ...report,
        webUrl: `${config.WEB_URL}/report/${report._id}`,
      }));

      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data,
      });
    } catch (error) {
      next(error);
    }
  };

  // Loads a report and verifies the requester is allowed to mutate it
  // (same company / tenant). Returns the report, or null after sending the
  // appropriate error response. Closes the IDOR on update/delete where any
  // authenticated user could modify any report by id.
  private static loadReportForMutation = async (
    req: AuthenticatedRequest,
    res: express.Response,
    reportId: string,
  ) => {
    if (!reportId || !isValidObjectId(reportId)) {
      ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
        message: "Validation error",
      });
      return null;
    }

    const report = await ProjectReportsHelpers.getReportById(
      ObjectId(reportId),
    );

    if (!report) {
      ErrorResponse(res, status.NOT_FOUND, { message: "Report not found" });
      return null;
    }

    if (String(report.companyId) !== String(req.user.companyId)) {
      ErrorResponse(res, status.FORBIDDEN, {
        message: "You are not authorized to modify this report",
      });
      return null;
    }

    return report;
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        id: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const reportId = req.params.id;

      const authorizedReport = await ProjectReportsRoutes.loadReportForMutation(
        req,
        res,
        reportId,
      );
      if (!authorizedReport) {
        return;
      }

      const {
        projectId,
        reportName,
        photosPerPage,
        showCoverPage,
        showCoverPageImage,
        coverPageImage,
        showCompanyName,
        showCompanyLogo,
        showCreatedBy,
        showCreatedAt,
        showPageCount,
        sections,
      } = req.body;

      const reportPayload = {
        projectId,
        reportName,
        photosPerPage,
        showCoverPage,
        showCoverPageImage,
        coverPageImage,
        showCompanyName,
        showCompanyLogo,
        showCreatedBy,
        showCreatedAt,
        showPageCount,
      };

      await ProjectReportsHelpers.updateReport(
        ObjectId(reportId),
        reportPayload,
      );

      const sectionIds = sections
        .filter((section) => section._id)
        .map((section) => ObjectId(section._id));
      const removedSections = await ProjectReportsHelpers.findRemovedSections(
        ObjectId(reportId),
        sectionIds,
      );
      const removedSectionIds = removedSections.map((section) => section._id);

      await ProjectReportsHelpers.deleteSections(
        ObjectId(reportId),
        removedSectionIds,
      );
      await ProjectReportsHelpers.deleteSubSectionsBySectionId(
        removedSectionIds,
        [],
      );

      await Promise.all(
        sections.map(async (sectionData, index) => {
          const { sectionName, sectionDescription, subSections } = sectionData;
          let sectionId = sectionData._id;
          const sectionPayload = {
            reportId: reportId,
            sectionName,
            sectionDescription,
            order: index,
          };

          if (sectionData._id) {
            await ProjectReportsHelpers.updateSection(
              ObjectId(sectionData._id),
              sectionPayload,
            );
          } else {
            const newSection =
              await ProjectReportsHelpers.createSection(sectionPayload);
            sectionId = newSection._id;
          }

          if (sectionData._id) {
            const subSectionIds = await subSections
              .filter((subSection) => subSection._id)
              .map((subSection) => ObjectId(subSection._id));
            await ProjectReportsHelpers.deleteSubSectionsBySectionId(
              [ObjectId(sectionData._id)],
              subSectionIds,
            );
          }

          await Promise.all(
            subSections.map(async (subSectionData, index) => {
              const { subSectionName, image, description, uploadData } =
                subSectionData;
              const obj: IPreSubSectionData = {
                sectionId: sectionId,
                order: index,
                description,
              };
              if (image) {
                obj.image = image;
                obj.uploadData = uploadData;
                obj.userId = req.user._id;
              } else {
                obj.subSectionName = subSectionName;
              }
              if (subSectionData._id) {
                await ProjectReportsHelpers.updateSubSections(
                  ObjectId(subSectionData._id),
                  obj,
                );
              } else {
                await ProjectReportsHelpers.createSubSections([obj]);
              }
            }),
          );
        }),
      );

      if (projectId) {
        ProjectHelper.updateProjectInfo(projectId);
      }

      return SuccessResponse(res, status.OK, {
        message: "Update Successfull.",
      });
    } catch (error) {
      next(error);
    }
  };

  public static delete = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        id: "required|string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Validation error",
          errors: validator.errors,
        });
      }

      const reportId = req.params.id;

      const authorizedReport = await ProjectReportsRoutes.loadReportForMutation(
        req,
        res,
        reportId,
      );
      if (!authorizedReport) {
        return;
      }

      await ProjectReportsHelpers.moveToTrash(ObjectId(reportId));

      return SuccessResponse(res, status.OK, {
        message: "Deleted Successfully",
      });
    } catch (error) {
      next(error);
    }
  };
}
