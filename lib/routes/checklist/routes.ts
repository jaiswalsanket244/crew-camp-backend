import * as express from "express";
import * as status from "http-status";
import {
  ErrorResponse,
  SuccessResponse,
} from "../../utils/helpers/apiResponse";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import {
  escapeRegExp,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { Validator } from "node-input-validator";
import { ChecklistHelper } from "./helper";
import { Checklist } from "../../db";
import {
  CHECKLIST_STATUS,
  CHECKLIST_TYPE,
  FIELD_TYPE,
} from "../../utils/enums/checklist";
import { ProjectHelper } from "../projects/helper";
import { PostsHelper } from "../posts/helper";
import {
  TodoStatusQuery,
  FieldDefinitionType,
  FieldResponseValue,
  FindMyChecklistsPayload,
  FindMyChecklistsQuery,
} from "../../utils/interfaces/schemaInterface";
import { PostType } from "../../utils/interfaces/post";
import { fileService } from "../../services/awsBucket";
import {
  isTaskComplete,
  validateFieldDefinition,
  validateResponseValue,
} from "../../utils/helpers/checklistFields";
import { PDFService } from "../../services/pdfService";
import { CompanyHelpers } from "../company/helpers";
import { Types } from "mongoose";

export class ChecklistRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validatorBody = new Validator(req.body, {
        projectId: "string|required",
        name: "string|required",
      });

      const validatorQuery = new Validator(req.query, {
        type: "string|required",
      });

      const matchedBody = await validatorBody.check();
      const matchedQuery = await validatorQuery.check();
      if (!matchedBody || !matchedQuery) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validatorBody.errors || validatorQuery.errors,
          errors: validatorBody.errors || validatorQuery.errors,
        });
      }

      req.body.companyId = req.user.companyId;
      req.body.todoList = req.body.todoList.filter((todo) => todo.name);

      await ChecklistHelper.create(req.user._id, req.body, req.query.type);
      ProjectHelper.updateProjectInfo(req.body.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Checklist created successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getChecklists = async (
    req: AuthenticatedRequest & { query: { taskId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        search: "string",
        onlyMyProjects: "boolean",
        onlyMine: "boolean",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (req.query.projectId && !isValidObjectId(req.query.projectId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }

      if (
        req.query.type &&
        !Object.values(CHECKLIST_TYPE).includes(
          req.query.type as CHECKLIST_TYPE,
        )
      ) {
        req.query.type = CHECKLIST_TYPE.CHECKLIST;
      }

      const {
        projectId,
        checklistId,
        type,
        search,
        limit,
        onlyMyProjects,
        onlyMine,
      } = req.query;

      // Personal View — "my checklists" needs identity. This route sits before
      // authMiddleware, so req.user may be absent; guard explicitly.
      if (onlyMine === "true" && !req.user?._id) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Unauthorized",
        });
      }

      const myProjectIds = await ProjectHelper.getMyProjectsArray(
        req?.user?._id,
      );

      const payload: any = {
        type,
        status: { $ne: CHECKLIST_STATUS.DELETED },
      };

      if (projectId && isValidObjectId(projectId))
        payload.projectId = ObjectId(projectId);
      else if (checklistId && isValidObjectId(checklistId))
        payload["_id"] = ObjectId(checklistId);
      else {
        payload.companyId = req.user.companyId;
        // Restrict to checklists from projects the user is a member of.
        // onlyMine implies this scope: authorship/contribution only counts
        // inside projects the caller is still an active member of, matching
        // GET /projectTasks/mine and /projectReports/mine. It also keeps the
        // query on { projectId: 1 } instead of scanning the whole company.
        if (onlyMyProjects === "true" || onlyMine === "true") {
          payload.projectId = { $in: myProjectIds.map((id) => ObjectId(id)) };
        }
        // Personal View — checklists I created or contribute to (across projects).
        // Additive to the global branch only; search sets payload.name (not $or),
        // so the two never collide.
        if (onlyMine === "true") {
          payload.$or = [
            { userId: ObjectId(req.user._id) },
            { contributors: ObjectId(req.user._id) },
          ];
        }
      }

      if (search) {
        // Literal substring match (escaped + capped) — no regex injection / ReDoS.
        payload.name = {
          $regex: escapeRegExp(String(search).slice(0, 100)),
          $options: "i",
        };
      }

      let limitValue = limit ? parseInt(limit as string, 10) : undefined;

      // Personal View — onlyMine reuses the heavy full-hydration pipeline (todos
      // + images per checklist). Never let it run unbounded: default + cap
      // server-side rather than trusting the client to send a limit.
      if (onlyMine === "true") {
        limitValue =
          Number.isFinite(limitValue) && limitValue > 0
            ? Math.min(limitValue, 200)
            : 50;
      }

      // Only the onlyMine path carries the extra isProjectArchived field, so the
      // default (project-scoped / plain global) response shape is unchanged.
      const [data, totalCounts] = await Promise.all([
        ChecklistHelper.findAllChecklist(payload, limitValue, {
          includeProjectArchived: onlyMine === "true",
        }),
        ChecklistHelper.countByProject(projectId),
      ]);

      const op = data.map((p) =>
        req.isExternalRequest
          ? { ...p }
          : {
              ...p,
              isMember: myProjectIds.includes(p.projectId.toString()),
            },
      );

      return SuccessResponse(res, status.OK, {
        data: op,
        totalCounts,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getChecklistDetails = async (
    req: AuthenticatedRequest & { query: { taskId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        checklistId: "string|required",
        type: `string|required|in:${Object.values(CHECKLIST_TYPE).join(",")}`,
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (
        req.query.projectId &&
        !isValidObjectId(req.query.projectId) &&
        req.query.checklistId &&
        !isValidObjectId(req.query.checklistId)
      ) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }
      const { checklistId, type } = req.query;
      const [checklist, todoList, myProjectIds] = await Promise.all([
        await ChecklistHelper.findAllChecklist({
          _id: ObjectId(checklistId),
          type,
        }),
        await ChecklistHelper.findAllTodos(req.query),
        ProjectHelper.getMyProjectsArray(req?.user?._id),
      ]);

      const returnData = {
        ...checklist[0],
        todoList,
      };

      if (!req.isExternalRequest) {
        returnData.isMember = myProjectIds.includes(
          checklist[0].projectId.toString(),
        );
      }

      return SuccessResponse(res, status.OK, {
        data: returnData,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateStatus = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        todoListId: "string|required",
        status: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const query: TodoStatusQuery = { status: req.body.status };
      const { todoListId, images } = req.body;

      if (req.body.status === CHECKLIST_STATUS.COMPLETED) {
        query.completedBy = req.user._id;
        query.completedAt = new Date();
      } else {
        query.completedBy = null;
        query.completedAt = null;
      }

      const todo = await ChecklistHelper.findTodo(todoListId);
      if (!todo) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Todo not found",
        });
      }

      if (req.body.status === CHECKLIST_STATUS.COMPLETED) {
        if (todo.areImagesMandatory && (!images?.length || images.length < 1)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Please upload images",
          });
        }

        if (todo.areImagesMandatory) {
          await ChecklistHelper.todoUpdateImages(
            images.map((image) => ({
              checklistId: todo.checklistId,
              todoListId: todoListId,
              imageData: image,
            })),
          );
        }
      } else if (todo.areImagesMandatory) {
        const todoListImages = await ChecklistHelper.findTodoListImages({
          todoListId: todo._id,
          "imageData.isPost": { $ne: true },
        });
        const images = todoListImages.map((image) =>
          image.imageData.url.split("/").pop(),
        );

        Promise.all(images.map((image) => fileService.deleteFromS3(image)));
        await ChecklistHelper.deleteTodoListImages(todo._id);
      }

      await ChecklistHelper.todoUpdate({ todoListId, query });

      ChecklistRoutes.touchProject(todo.checklistId);

      return SuccessResponse(res, status.OK, {
        message: "Status updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static update = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        checklistId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (
        !req.body.update &&
        !req.body.remove &&
        !req.body.name &&
        !req.body.contributors
      ) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "No field was given",
        });
      }

      await ChecklistHelper.put(req.body);

      ChecklistRoutes.touchProject(req.body.checklistId);

      return SuccessResponse(res, status.OK, {
        message: "Checklist updated successfully",
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
      if (req.params.id && !isValidObjectId(req.params.id)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Empty or Invalid field",
        });
      }
      await ChecklistHelper.delete(req.params.id);

      return SuccessResponse(res, status.OK, {
        message: "Checklist deleted successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static completeCheckList = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        checklistId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { checklistId } = req.query;
      const { user } = req;
      const userId = user._id;

      await ChecklistHelper.completeCheckList(ObjectId(checklistId), userId);

      ChecklistRoutes.touchProject(ObjectId(checklistId));

      return SuccessResponse(res, status.OK, {
        message: "Status updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static inProgressCheckList = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        checklistId: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { checklistId } = req.query;

      await ChecklistHelper.inProgressCheckList(ObjectId(checklistId));

      ChecklistRoutes.touchProject(ObjectId(checklistId));

      return SuccessResponse(res, status.OK, {
        message: "Status updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateTodoQuestionValue = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        todoListId: "string|required",
        questionId: "string|required",
        value: "string",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { todoListId, questionId, value } = req.body;
      if (!isValidObjectId(todoListId) || !isValidObjectId(questionId)) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid todoListId or questionId",
        });
      }

      const updatedTodo = await ChecklistHelper.updateTodoQuestionValue(
        todoListId,
        questionId,
        value,
      );

      if (!updatedTodo) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Todo or question not found",
        });
      }

      ChecklistRoutes.touchProject(updatedTodo.checklistId);

      return SuccessResponse(res, status.OK, {
        message: "Question value updated successfully",
        data: updatedTodo,
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateStatusV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        todoListId: "string|required",
        status: "string|required",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const query: TodoStatusQuery = { status: req.body.status };
      const { todoListId, images } = req.body;

      if (req.body.status === CHECKLIST_STATUS.COMPLETED) {
        query.completedBy = req.user._id;
        query.completedAt = new Date();
      } else {
        query.completedBy = null;
        query.completedAt = null;
      }

      const todo = await ChecklistHelper.findTodo(todoListId);
      if (!todo) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Todo not found",
        });
      }

      const checklist = await Checklist.findById(todo.checklistId);

      if (req.body.status === CHECKLIST_STATUS.COMPLETED) {
        // V2 guard: typed-field tasks cannot be manually completed until every
        // required field is answered. Field-less tasks keep pure manual
        // semantics. Photos supplied in THIS request satisfy the mandatory-photo
        // arm of isTaskComplete (the dedicated "Please upload images" check
        // below still enforces the requirement when none are provided).
        if (Array.isArray(todo.fields) && todo.fields.length > 0) {
          const completable = {
            fields: todo.fields,
            responses: todo.responses,
            areImagesMandatory: todo.areImagesMandatory,
            postId: todo.postId,
            images: images?.length ? images : undefined,
          };
          if (!isTaskComplete(completable)) {
            return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
              message: "Answer required fields first",
            });
          }
        }

        if (todo.areImagesMandatory && (!images?.length || images.length < 1)) {
          return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
            message: "Please upload images",
          });
        }

        if (images?.length) {
          const postPayload: PostType = {
            projectId: checklist.projectId,
            note: `Checklist: ${checklist.name} - ${todo.name}`,
            files: images,
          };
          const post = await PostsHelper.create(
            req.user._id,
            postPayload,
            req.user.companyId,
          );

          await ChecklistHelper.todoUpdatePostId(todoListId, post._id);
        }
      } else if (todo.postId) {
        await ChecklistHelper.todoUpdatePostId(todoListId, null);
      }

      await ChecklistHelper.todoUpdate({ todoListId, query });

      if (checklist?.projectId) {
        ProjectHelper.updateProjectInfo(checklist.projectId);
      }

      return SuccessResponse(res, status.OK, {
        message: "Status updated successfully",
      });
    } catch (error) {
      next(error);
    }
  };

  public static getChecklistDetailsV2 = async (
    req: AuthenticatedRequest & { query: { taskId: string } },
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        checklistId: "string|required",
        type: `string|required|in:${Object.values(CHECKLIST_TYPE).join(",")}`,
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (
        req.query.projectId &&
        !isValidObjectId(req.query.projectId) &&
        req.query.checklistId &&
        !isValidObjectId(req.query.checklistId)
      ) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }
      const { checklistId, type } = req.query;

      const checklistDetail = await ChecklistHelper.getChecklistDetailById(
        ObjectId(checklistId),
      );

      if (!checklistDetail) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Checklist not found",
        });
      }

      const [checklist, todoList, myProjectIds] = await Promise.all([
        ChecklistHelper.findAllChecklist({
          _id: ObjectId(checklistId),
          type,
        }),
        ChecklistHelper.findAllTodosV3(
          req.query,
          checklistDetail.projectId,
          checklistDetail.companyId,
        ),
        ProjectHelper.getMyProjectsArray(req?.user?._id),
      ]);

      const returnData = {
        ...checklist[0],
        todoList,
      };

      if (!req.isExternalRequest) {
        returnData.isMember = myProjectIds.includes(
          checklist[0].projectId.toString(),
        );
      }

      return SuccessResponse(res, status.OK, {
        data: returnData,
      });
    } catch (error) {
      next(error);
    }
  };

  // ---------------------------------------------------------------------------
  // V2 — typed fields
  // ---------------------------------------------------------------------------

  public static createV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validatorBody = new Validator(req.body, {
        projectId: "string|required",
        name: "string|required",
      });
      const validatorQuery = new Validator(req.query, {
        type: `string|required|in:${Object.values(CHECKLIST_TYPE).join(",")}`,
      });

      const matchedBody = await validatorBody.check();
      const matchedQuery = await validatorQuery.check();
      if (!matchedBody || !matchedQuery) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validatorBody.errors || validatorQuery.errors,
          errors: validatorBody.errors || validatorQuery.errors,
        });
      }

      // Structural validation of every task's field definitions.
      const fieldErrors = ChecklistRoutes.validateTaskFields(req.body.tasks);
      if (fieldErrors) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid field definition",
          errors: fieldErrors,
        });
      }

      req.body.companyId = req.user.companyId;

      const checklistId = await ChecklistHelper.createV2(
        req.user._id,
        req.body,
        req.query.type as string,
      );
      ProjectHelper.updateProjectInfo(req.body.projectId);

      return SuccessResponse(res, status.CREATED, {
        message: "Checklist created successfully",
        data: { checklistId },
      });
    } catch (error) {
      next(error);
    }
  };

  public static updateV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      // tasks is optional-but-typed: omitted = metadata-only update (todos
      // untouched — see the guard in ChecklistHelper.updateV2), [] = explicit
      // clear-all, array = full replace.
      const validator = new Validator(req.body, {
        checklistId: "string|required",
        tasks: "array",
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const fieldErrors = ChecklistRoutes.validateTaskFields(req.body.tasks);
      if (fieldErrors) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "Invalid field definition",
          errors: fieldErrors,
        });
      }

      // Reject payloads referencing todos that belong to another checklist.
      const ownershipError = await ChecklistHelper.verifyTaskOwnership(
        req.body.checklistId,
        req.body.tasks,
      );
      if (ownershipError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: ownershipError,
        });
      }

      await ChecklistHelper.updateV2(req.user._id, req.body);

      // Return the updated checklist in the details/v3 shape (saves a refetch).
      // Type is resolved from the stored checklist inside buildDetailsV3.
      const { checklistId } = req.body;
      const returnData = await ChecklistRoutes.buildDetailsV3(
        req,
        ObjectId(checklistId),
      );

      if (!returnData) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Checklist not found",
        });
      }
      ProjectHelper.updateProjectInfo(req.body.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Checklist updated successfully",
        data: returnData,
      });
    } catch (error) {
      next(error);
    }
  };

  public static getChecklistDetailsV3 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        checklistId: "string|required",
        type: `string|required|in:${Object.values(CHECKLIST_TYPE).join(",")}`,
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (req.query.checklistId && !isValidObjectId(req.query.checklistId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values",
        });
      }

      const { checklistId, type } = req.query;

      const returnData = await ChecklistRoutes.buildDetailsV3(
        req,
        ObjectId(checklistId),
        type as CHECKLIST_TYPE,
      );

      if (!returnData) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Checklist not found",
        });
      }

      return SuccessResponse(res, status.OK, {
        data: returnData,
      });
    } catch (error) {
      next(error);
    }
  };

  public static saveFieldResponse = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.body, {
        checklistId: "string|required",
        todoListId: "string|required",
        fieldId: "string|required",
        fieldType: `string|required|in:${Object.values(FIELD_TYPE).join(",")}`,
      });

      const matched = await validator.check();
      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      const { checklistId, todoListId, fieldId, fieldType } = req.body;
      const value: FieldResponseValue = req.body.value ?? null;

      if (
        !isValidObjectId(checklistId) ||
        !isValidObjectId(todoListId) ||
        !isValidObjectId(fieldId)
      ) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid identifiers",
        });
      }

      // Scoped by checklistId so the membership check below (which runs
      // against this checklist's project) genuinely covers the todo being
      // written — a todoListId from another checklist must 404.
      const todo = await ChecklistHelper.findTodoInChecklist(
        todoListId,
        checklistId,
      );
      if (!todo) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Todo not found",
        });
      }

      const checklist = await Checklist.findById(checklistId);
      if (!checklist) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Checklist not found",
        });
      }

      // Permission: caller must be a member of the checklist's project.
      const myProjectIds = await ProjectHelper.getMyProjectsArray(req.user._id);
      if (!myProjectIds.includes(checklist.projectId.toString())) {
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Not a project member",
        });
      }

      // Resolve the field: from todo.fields, or legacy questions (as text).
      let field: FieldDefinitionType | undefined;
      let isLegacyQuestion = false;
      const storedFields: FieldDefinitionType[] = Array.isArray(todo.fields)
        ? (todo.fields as unknown as FieldDefinitionType[])
        : [];
      field = storedFields.find((f) => String(f._id) === String(fieldId));

      if (!field) {
        const questions = Array.isArray(todo.questions)
          ? (todo.questions as { _id?: unknown; label?: string }[])
          : [];
        const question = questions.find(
          (q) => q._id && String(q._id) === String(fieldId),
        );
        if (question) {
          field = {
            _id: fieldId,
            fieldType: FIELD_TYPE.TEXT,
            label: question.label || "",
            required: false,
            sortOrder: 0,
            config: { multiline: true },
          };
          isLegacyQuestion = true;
        }
      }

      if (!field) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Field not found",
        });
      }

      if (field.fieldType !== fieldType) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: "fieldType does not match stored field",
        });
      }

      const valueError = validateResponseValue(field, value);
      if (valueError) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: valueError,
          errors: { value: valueError },
        });
      }

      const result = await ChecklistHelper.saveFieldResponse({
        todoListId,
        fieldId,
        fieldType,
        value,
        userId: req.user._id,
        isLegacyQuestion,
      });

      const totals = await ChecklistHelper.getChecklistFieldTotals(
        ObjectId(checklistId),
      );

      ProjectHelper.updateProjectInfo(checklist.projectId);

      return SuccessResponse(res, status.OK, {
        message: "Response saved",
        data: {
          todoListId,
          status: result.status,
          completedBy: result.completedBy,
          completedAt: result.completedAt,
          completedFields: totals.completedFields,
          totalFields: totals.totalFields,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static exportPDF = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.params, {
        checklistId: "string|required",
      });

      const validatorQuery = new Validator(req.query, {
        type: `string|in:${Object.values(CHECKLIST_TYPE).join(",")}`,
      });

      const matched = await validator.check();
      const matchedQuery = await validatorQuery.check();

      if (!matched || !matchedQuery) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors || validatorQuery.errors,
          errors: validator.errors || validatorQuery.errors,
        });
      }

      const { checklistId } = req.params;
      const type = req.query.type || CHECKLIST_TYPE.CHECKLIST;

      if (!isValidObjectId(checklistId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "Invalid checklist ID",
        });
      }

      // First get the checklist detail to verify it exists and get projectId/companyId
      const checklistDetail = await ChecklistHelper.getChecklistDetailById(
        ObjectId(checklistId),
      );

      if (!checklistDetail) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Checklist not found",
        });
      }

      // Fetch all data similar to getChecklistDetailsV2
      const [checklist, todoList, project, company] = await Promise.all([
        ChecklistHelper.findAllChecklist({
          _id: ObjectId(checklistId),
          type,
        }),
        ChecklistHelper.findAllTodosV3(
          { checklistId },
          checklistDetail.projectId,
          checklistDetail.companyId,
        ),
        ProjectHelper.getProjectData(checklistDetail.projectId),
        CompanyHelpers.getCompanyById(checklistDetail.companyId),
      ]);

      if (!checklist || checklist.length === 0) {
        return ErrorResponse(res, status.NOT_FOUND, {
          message: "Checklist not found",
        });
      }

      // Prepare the data similar to getChecklistDetailsV2
      const checklistData = {
        ...checklist[0],
        todoList,
        project,
        company,
      };

      // Generate the PDF with the fetched data
      const pdfBuffer = await PDFService.generateChecklistPDFFromData(
        checklistData,
        req.user,
      );

      // Validate the buffer
      if (!pdfBuffer || pdfBuffer.length === 0) {
        throw new Error("PDF generation returned empty buffer");
      }

      // Set response headers for PDF download
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="checklist-${checklist[0].name.replace(/[^a-zA-Z0-9]/g, "-")}-${Date.now()}.pdf"`,
      );
      res.setHeader("Content-Length", pdfBuffer.length.toString());

      // Important: Set binary encoding for the response
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");

      // Send the PDF buffer as binary
      return res.status(200).end(pdfBuffer, "binary");
    } catch (error) {
      next(error);
    }
  };

  // Validate every task's field definitions; returns a keyed error map on the
  // first failure, or null when all valid.
  private static validateTaskFields = (
    tasks: { fields?: FieldDefinitionType[] }[] | undefined,
  ): Record<string, string> | null => {
    if (!Array.isArray(tasks)) return null;
    for (let t = 0; t < tasks.length; t++) {
      const fields = tasks[t]?.fields;
      if (!Array.isArray(fields)) continue;
      for (let f = 0; f < fields.length; f++) {
        // Skip blank-label placeholders — createV2/updateV2 drop them.
        const label = fields[f]?.label;
        if (typeof label === "string" && label.trim() === "") continue;
        const error = validateFieldDefinition(fields[f]);
        if (error) {
          return { [`tasks[${t}].fields[${f}]`]: error };
        }
      }
    }
    return null;
  };

  // Build the details/v3 return payload (checklist + mapped todos + field totals).
  // When `type` is omitted, it is resolved from the stored checklist (used by
  // updateV2, whose body carries no type).
  private static buildDetailsV3 = async (
    req: AuthenticatedRequest,
    checklistId: ReturnType<typeof ObjectId>,
    type?: CHECKLIST_TYPE,
  ) => {
    const checklistDetail =
      await ChecklistHelper.getChecklistDetailById(checklistId);
    if (!checklistDetail) return null;

    const resolvedType =
      type ??
      (checklistDetail.type as CHECKLIST_TYPE) ??
      CHECKLIST_TYPE.CHECKLIST;

    const [checklist, todoList, myProjectIds] = await Promise.all([
      ChecklistHelper.findAllChecklist({
        _id: checklistId,
        type: resolvedType,
      }),
      ChecklistHelper.findAllTodosV3WithFields(
        { checklistId: String(checklistId) },
        checklistDetail.projectId,
        checklistDetail.companyId,
      ),
      ProjectHelper.getMyProjectsArray(req?.user?._id),
    ]);

    if (!checklist?.length) return null;

    const totals = ChecklistHelper.computeChecklistFieldTotals(todoList);

    const returnData: Record<string, unknown> = {
      ...checklist[0],
      todoList,
      totalFields: totals.totalFields,
      completedFields: totals.completedFields,
    };

    if (!req.isExternalRequest) {
      returnData.isMember = myProjectIds.includes(
        checklist[0].projectId.toString(),
      );
    }

    return returnData;
  };

  // Fire-and-forget: bumps the parent project's updatedAt after checklist changes.
  private static touchProject = async (
    checklistId: string | Types.ObjectId,
  ) => {
    try {
      const checklist = await Checklist.findById(checklistId, {
        projectId: 1,
      });
      if (checklist?.projectId) {
        await ProjectHelper.updateProjectInfo(checklist.projectId);
      }
    } catch {
      // non-critical; never block the response
    }
  };

  public static getChecklistsV2 = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const validator = new Validator(req.query, {
        search: "string",
        type: "string",
        onlyMyProjects: "boolean",
      });

      const matched = await validator.check();

      if (!matched) {
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
          errors: validator.errors,
        });
      }

      if (req.query.projectId && !isValidObjectId(req.query.projectId)) {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values projectId",
        });
      }

      if (
        req.query.type &&
        Object.values(CHECKLIST_TYPE).includes(req.query.type as CHECKLIST_TYPE)
      ) {
        req.query.type = CHECKLIST_TYPE.CHECKLIST;
      } else {
        return ErrorResponse(res, status.BAD_REQUEST, {
          message: "missing values type",
        });
      }

      const { projectId, type, search, onlyMyProjects } = req.query;

      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 50;
      const query: FindMyChecklistsQuery = {
        page,
        limit,
        skip: (page - 1) * limit,
      };

      const myProjectIds = await ProjectHelper.getMyProjectsArrayV2(
        req.user._id,
      );

      const payload: FindMyChecklistsPayload = {
        type: type as CHECKLIST_TYPE,
        status: { $ne: CHECKLIST_STATUS.DELETED },
        companyId: req.user.companyId,
      };

      if (projectId && isValidObjectId(projectId))
        payload.projectId = ObjectId(projectId);
      else {
        if (onlyMyProjects === "true") {
          payload.projectId = { $in: myProjectIds };
        }
      }

      if (search) {
        // Literal substring match (escaped + capped) — no regex injection / ReDoS.
        payload.name = {
          $regex: escapeRegExp(String(search).slice(0, 100)),
          $options: "i",
        };
      }

      const data = await ChecklistHelper.findMyChecklists(payload, query);

      const myProjectIdsString = myProjectIds.map((id) => id.toString());

      const items = data.items.map((p) =>
        req.isExternalRequest
          ? { ...p }
          : {
              ...p,
              isMember: myProjectIdsString.includes(p.projectId.toString()),
            },
      );

      data.items = items;

      return SuccessResponse(res, status.OK, {
        data: data,
      });
    } catch (error) {
      next(error);
    }
  };
}
