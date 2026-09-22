import {
  getProjectNamePipeline,
  getUserNamePipeline,
  isValidObjectId,
  ObjectId,
} from "../../utils/helpers/commonHelper";
import { Checklist, TodoList, TodoListImages, User } from "../../db";
import { CURRENT_STATUS } from "../../utils/enums/enums";
import {
  ChecklistType,
  ChecklistIdQuery,
  TodoResponseType,
  TodoType,
  CreateChecklistV2Type,
  UpdateChecklistV2Type,
  TaskV2PayloadType,
  FieldDefinitionType,
  FieldResponseType,
  FieldResponseValue,
  FindMyChecklistsPayload,
  FindMyChecklistsQuery,
  MyChecklistType,
} from "../../utils/interfaces/schemaInterface";
import { Types } from "mongoose";
import {
  CHECKLIST_STATUS,
  CHECKLIST_TYPE,
  FIELD_TYPE,
} from "../../utils/enums/checklist";
import { FormattedChecklist, FormattedTodos } from "../../integrations";
import {
  countTodoFields,
  isTaskComplete,
  stripConfig,
} from "../../utils/helpers/checklistFields";

type mongoId = Types.ObjectId;

// Loosely-typed shape for todos read from Mongoose (documents or lean objects)
// passed into the V2 status/response helpers. Only the fields those helpers
// actually read are declared; questions is intentionally loose to accept
// FlattenMaps results.
interface TodoDocLike {
  _id: mongoId;
  checklistId?: mongoId;
  status?: string;
  areImagesMandatory?: boolean;
  postId?: unknown;
  images?: unknown[];
  fields?: FieldDefinitionType[];
  responses?: FieldResponseType[];
  questions?: { _id?: unknown; label?: string; value?: string }[];
}

// Minimal user projection used to attribute checklist answers and uploads.
interface ContributorUserDoc {
  _id: mongoId;
  name?: { first?: string; last?: string };
  profileImage?: string | null;
}

// Contributor identity as returned to clients alongside a response or upload.
interface ChecklistContributor {
  _id: mongoId;
  userName: string;
  profileImage: string | null;
}

export class ChecklistHelper {
  public static create = async (
    userId: string,
    body: ChecklistType,
    type: string,
  ) => {
    const { name, projectId, contributors, todoList, companyId } = body;

    const checklist = await Checklist.create({
      userId,
      projectId,
      name,
      type,
      contributors,
      companyId,
    });

    const documents = todoList.map((todo: TodoType) => {
      const document = {
        name: todo.name,
        sortOrder: todo.sortOrder,
        checklistId: checklist._id,
        areImagesMandatory: todo.areImagesMandatory,
      };
      if (todo?.description) {
        document["description"] = todo.description;
      }
      if (todo?.questions) {
        document["questions"] = todo.questions.filter(
          (question) => question.label.trim() !== "",
        );
      }
      if (todo?.taskImages?.length) {
        document["taskImages"] = todo.taskImages;
      }
      return document;
    });

    if (todoList.length) {
      await TodoList.insertMany(documents);
    }
  };

  public static createChecklistFromCompanyCam = async (
    payload: FormattedChecklist,
  ) => {
    return Checklist.create(payload);
  };

  public static insertTodoLists = async (payload: FormattedTodos[]) => {
    if (!payload.length) return;
    return TodoList.insertMany(payload);
  };

  public static createTodoList = async (payload: FormattedTodos) => {
    return TodoList.create(payload);
  };

  public static addContributorsToChecklist = async (
    checklistId: mongoId,
    userIds: mongoId[],
  ) => {
    return Checklist.findByIdAndUpdate(checklistId, {
      $addToSet: { contributors: { $each: userIds } },
    });
  };

  // Tab badge count for Checklists. Mirrors getChecklists' payload (checklist
  // routes.ts): non-template (type CHECKLIST), non-deleted only — matches the tab.
  //
  // Returns 0 unless the request is genuinely project-scoped. The list route
  // calls this on every path, including the global / checklistId / onlyMine ones
  // that carry no projectId at all, and ObjectId() throws on "" while silently
  // minting a RANDOM id on undefined — a 500 on the first, a guaranteed-empty
  // query on the rest.
  public static countByProject = async (projectId?: string) => {
    if (!projectId || !isValidObjectId(projectId)) return 0;
    return Checklist.countDocuments({
      projectId: ObjectId(projectId),
      type: CHECKLIST_TYPE.CHECKLIST,
      status: { $ne: CHECKLIST_STATUS.DELETED },
    });
  };

  public static findAllChecklist = async (
    query,
    limit?: number,
    options?: { includeProjectArchived?: boolean },
  ) => {
    const userNamePipeline = getUserNamePipeline();
    const projectNamePipeline = getProjectNamePipeline();

    const projectStage: Record<string, unknown> = {
      name: 1,
      userName: 1,
      contributors: {
        $map: {
          input: "$contributorsInfo",
          as: "contributor",
          in: {
            // Null-safe: $concat returns null if either part is missing, and
            // name.last is optional for phone-signup (guest) users.
            userName: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ["$$contributor.name.first", ""] },
                    " ",
                    { $ifNull: ["$$contributor.name.last", ""] },
                  ],
                },
              },
            },
            profileImage: "$$contributor.profileImage",
            _id: "$$contributor._id",
          },
        },
      },
      todoList: {
        $sortArray: { input: "$todoList", sortBy: { sortOrder: 1 } },
      },
      totalTodo: { $size: "$todoList" },
      completedTodo: {
        $size: {
          $filter: {
            input: "$todoList",
            as: "todo",
            cond: { $eq: ["$$todo.status", CHECKLIST_STATUS.COMPLETED] },
          },
        },
      },
      // V2 progress: total/answered field counts (legacy questions count as
      // text fields). Mirrors isFieldAnswered — see checklistFields.ts.
      totalFields: {
        $reduce: {
          input: "$todoList",
          initialValue: 0,
          in: {
            $add: [
              "$$value",
              {
                $cond: [
                  {
                    $gt: [{ $size: { $ifNull: ["$$this.fields", []] } }, 0],
                  },
                  { $size: "$$this.fields" },
                  { $size: { $ifNull: ["$$this.questions", []] } },
                ],
              },
            ],
          },
        },
      },
      completedFields: {
        $reduce: {
          input: "$todoList",
          initialValue: 0,
          in: {
            $add: [
              "$$value",
              {
                $cond: [
                  {
                    $gt: [{ $size: { $ifNull: ["$$this.fields", []] } }, 0],
                  },
                  {
                    // Count answered typed fields.
                    $size: {
                      $filter: {
                        input: "$$this.fields",
                        as: "field",
                        cond: {
                          $let: {
                            vars: {
                              resp: {
                                $arrayElemAt: [
                                  {
                                    $filter: {
                                      input: {
                                        $ifNull: ["$$this.responses", []],
                                      },
                                      as: "r",
                                      cond: {
                                        $eq: ["$$r.fieldId", "$$field._id"],
                                      },
                                    },
                                  },
                                  0,
                                ],
                              },
                            },
                            in: {
                              $switch: {
                                branches: [
                                  {
                                    case: {
                                      $eq: ["$$field.fieldType", "checkbox"],
                                    },
                                    then: {
                                      $eq: ["$$resp.value", true],
                                    },
                                  },
                                  {
                                    case: {
                                      $eq: ["$$field.fieldType", "text"],
                                    },
                                    then: {
                                      $and: [
                                        {
                                          $eq: [
                                            { $type: "$$resp.value" },
                                            "string",
                                          ],
                                        },
                                        {
                                          $ne: [
                                            {
                                              $trim: {
                                                input: {
                                                  $ifNull: ["$$resp.value", ""],
                                                },
                                              },
                                            },
                                            "",
                                          ],
                                        },
                                      ],
                                    },
                                  },
                                  {
                                    case: {
                                      $eq: [
                                        "$$field.fieldType",
                                        "multi_select",
                                      ],
                                    },
                                    then: {
                                      $gt: [
                                        {
                                          $size: {
                                            $ifNull: ["$$resp.value", []],
                                          },
                                        },
                                        0,
                                      ],
                                    },
                                  },
                                ],
                                default: {
                                  $and: [
                                    { $ne: ["$$resp.value", null] },
                                    { $ne: ["$$resp.value", ""] },
                                    {
                                      $ne: [
                                        { $type: "$$resp.value" },
                                        "missing",
                                      ],
                                    },
                                  ],
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    // Legacy: count questions with a non-empty value.
                    $size: {
                      $filter: {
                        input: { $ifNull: ["$$this.questions", []] },
                        as: "q",
                        cond: {
                          $and: [
                            {
                              $eq: [{ $type: "$$q.value" }, "string"],
                            },
                            {
                              $ne: [
                                {
                                  $trim: {
                                    input: { $ifNull: ["$$q.value", ""] },
                                  },
                                },
                                "",
                              ],
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      createdAt: 1,
      projectId: 1,
      projectName: 1,
    };

    // Personal View only: add isProjectArchived so archived-project checklists
    // render read-only. Gated so default (non-onlyMine) responses are unchanged.
    if (options?.includeProjectArchived) {
      projectStage.isProjectArchived = {
        $cond: [
          { $ne: [{ $ifNull: ["$archivedAt", null] }, null] },
          true,
          false,
        ],
      };
    }

    // $sort and $limit run BEFORE the lookups below, so the expensive
    // hydration (todos + their images + contributors, per checklist) only
    // touches rows that are actually returned. With $limit last, a
    // company-wide $match — which is what onlyMine produces — hydrated every
    // match and then threw all but `limit` away.
    const pipeline: any[] = [
      {
        $match: query,
      },
      // _id tiebreaker keeps the "most recent N" slice deterministic when
      // createdAt ties.
      {
        $sort: {
          createdAt: -1,
          _id: -1,
        },
      },
      ...(limit ? [{ $limit: limit }] : []),
      ...userNamePipeline,
      ...projectNamePipeline,
      {
        $lookup: {
          from: "todolists",
          localField: "_id",
          foreignField: "checklistId",
          as: "todoList",
          pipeline: [{ $match: { status: { $ne: CHECKLIST_STATUS.DELETED } } }],
        },
      },
      {
        $lookup: {
          from: "todolistimages",
          localField: "_id",
          foreignField: "checklistId",
          as: "todoListImages",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "contributors",
          foreignField: "_id",
          as: "contributorsInfo",
        },
      },
      // Add attachments to each todo item
      {
        $addFields: {
          todoList: {
            $map: {
              input: "$todoList",
              as: "todo",
              in: {
                $mergeObjects: [
                  "$$todo",
                  {
                    attachments: {
                      $map: {
                        input: {
                          $filter: {
                            input: "$todoListImages",
                            as: "img",
                            cond: { $eq: ["$$img.todoListId", "$$todo._id"] },
                          },
                        },
                        as: "img",
                        in: {
                          _id: "$$img._id",
                          checkListId: "$$img.checklistId",
                          todoListId: "$$img.todoListId",
                          url: "$$img.imageData.url",
                          fileType: "$$img.imageData.fileType",
                          size: "$$img.imageData.size",
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
      {
        $project: projectStage,
      },
    ];

    return Checklist.aggregate(pipeline);
  };

  public static findAllTodos = async ({ checklistId }: any) => {
    if (!isValidObjectId(checklistId)) return [];
    const userNamePipeline = getUserNamePipeline("completedBy");
    const query: any = {
      checklistId: ObjectId(checklistId),
      status: { $ne: CHECKLIST_STATUS.DELETED },
    };
    return TodoList.aggregate([
      {
        $match: query,
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "todolistimages",
          localField: "_id",
          foreignField: "todoListId",
          as: "images",
        },
      },
      {
        $project: {
          name: 1,
          status: 1,
          completedAt: 1,
          completedBy: {
            _id: "$completedBy",
            userName: "$userName",
          },
          sortOrder: 1,
          checklistId: 1,
          createdAt: 1,
          images: 1,
          description: 1,
          areImagesMandatory: 1,
          questions: 1,
          taskImages: 1,
        },
      },
      {
        $sort: {
          sortOrder: 1,
          createdAt: -1,
        },
      },
    ]);
  };

  public static todoUpdate = async ({ todoListId, query }) => {
    const todo = await TodoList.findByIdAndUpdate(ObjectId(todoListId), {
      $set: query,
    });
    if (query.completedBy) {
      return Checklist.findByIdAndUpdate(todo.checklistId, {
        $addToSet: { contributors: query.completedBy },
      });
    }
    return todo;
  };

  public static todoUpdateImages = (payload) => {
    return TodoListImages.insertMany(payload);
  };

  public static completeCheckList = async (checklistId, userId) => {
    return Promise.all([
      TodoList.updateMany(
        {
          checklistId: checklistId,
          status: { $ne: CHECKLIST_STATUS.COMPLETED },
        },
        {
          $set: {
            status: CHECKLIST_STATUS.COMPLETED,
            completedBy: userId,
            completedAt: new Date(),
          },
        },
      ),
      Checklist.findByIdAndUpdate(checklistId, {
        $addToSet: { contributors: userId },
      }),
    ]);
  };

  public static inProgressCheckList = async (checklistId) => {
    return TodoList.updateMany(
      { checklistId: checklistId },
      {
        $set: {
          status: CHECKLIST_STATUS.PENDING,
          completedBy: null,
          completedAt: null,
        },
      },
    );
  };

  public static deleteTodoListImages = async (todoListId: mongoId) => {
    return TodoListImages.deleteMany({
      todoListId,
    });
  };

  public static put = async ({ update, name, contributors, checklistId }) => {
    const query: { name?: string; contributors?: mongoId[] } = {};

    if (name) query.name = name;
    query.contributors = contributors?.length ? contributors : [];

    if (Object.keys(query).length > 0) {
      await Checklist.findByIdAndUpdate(
        checklistId,
        { $set: query },
        { new: true },
      );
    }
    if (update) {
      await TodoList.deleteMany({
        checklistId,
        _id: {
          $nin: update
            .filter((todo) => todo._id)
            .map((todo) => ObjectId(todo._id)),
        },
      });

      await Promise.all(
        update.map(async (todo: TodoResponseType) => {
          if (!todo?.name) return;
          const questions = (todo.questions || []).filter(
            (question) => question.label.trim() !== "",
          );

          if (todo?._id) {
            await TodoList.findByIdAndUpdate(todo._id, {
              $set: {
                name: todo.name,
                description: todo.description || "",
                areImagesMandatory: todo.areImagesMandatory || false,
                sortOrder: todo.sortOrder,
                questions,
                checklistId,
                // preserve existing photos when old clients omit the field
                ...(todo.taskImages !== undefined && {
                  taskImages: todo.taskImages,
                }),
              },
            });
          } else {
            await TodoList.create({
              name: todo.name,
              description: todo.description || "",
              areImagesMandatory: todo.areImagesMandatory || false,
              sortOrder: todo.sortOrder,
              questions,
              checklistId,
              ...(todo.taskImages?.length && { taskImages: todo.taskImages }),
            });
          }
        }),
      );
    }
  };

  public static delete = async (checklistId: mongoId) => {
    await Checklist.findByIdAndUpdate(checklistId, {
      $set: { status: CHECKLIST_STATUS.DELETED },
    });
  };

  public static findTodo = async (todoListId: mongoId) => {
    return TodoList.findById(todoListId);
  };

  // Scoped variant for V2 writes: a todoListId from another checklist must
  // not resolve, or a member of checklist A's project could write responses
  // into checklist B by passing A's checklistId with B's todoListId.
  public static findTodoInChecklist = async (
    todoListId: mongoId | string,
    checklistId: mongoId | string,
  ) => {
    return TodoList.findOne({
      _id: ObjectId(String(todoListId)),
      checklistId: ObjectId(String(checklistId)),
    });
  };

  /**
   * Every task._id in a V2 update payload must already belong to the target
   * checklist — otherwise a stale or malicious payload could adopt/overwrite
   * todos from another checklist. Returns an error message or null.
   */
  public static verifyTaskOwnership = async (
    checklistId: mongoId | string,
    tasks: TaskV2PayloadType[] | undefined,
  ): Promise<string | null> => {
    const ids = (tasks || [])
      .filter((task) => task && task._id)
      .map((task) => ObjectId(String(task._id)));
    if (!ids.length) return null;

    const owned = await TodoList.countDocuments({
      _id: { $in: ids },
      checklistId: ObjectId(String(checklistId)),
    });
    return owned === ids.length
      ? null
      : "One or more tasks do not belong to this checklist";
  };

  public static findTodoListImages = async (payload) => {
    return TodoListImages.find(payload);
  };

  public static updateTodoQuestionValue = async (
    todoListId: string,
    questionId: string,
    value: string,
  ) => {
    return TodoList.findByIdAndUpdate(
      ObjectId(todoListId),
      {
        $set: {
          "questions.$[element].value": value,
        },
      },
      {
        arrayFilters: [{ "element._id": ObjectId(questionId) }],
      },
    );
  };

  public static getDeletedChecklists = async (companyId) => {
    const userNamePipeline = getUserNamePipeline();
    return Checklist.aggregate([
      {
        $match: {
          type: CHECKLIST_TYPE.CHECKLIST,
          status: CHECKLIST_STATUS.DELETED,
          // Excludes checklists binned along with their project.
          preDeleteStatus: { $exists: false },
          companyId,
        },
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "todolists",
          localField: "_id",
          foreignField: "checklistId",
          as: "todoList",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "contributors",
          foreignField: "_id",
          as: "contributorsInfo",
        },
      },
      {
        $project: {
          name: 1,
          userName: 1,
          contributors: {
            $map: {
              input: "$contributorsInfo",
              as: "contributor",
              in: {
                userName: {
                  $concat: [
                    "$$contributor.name.first",
                    " ",
                    "$$contributor.name.last",
                  ],
                },
                profileImage: "$$contributor.profileImage",
                _id: "$$contributor._id",
              },
            },
          },
          todoList: {
            $sortArray: { input: "$todoList", sortBy: { sortOrder: 1 } },
          },
          totalTodo: { $size: "$todoList" },
          completedTodo: {
            $size: {
              $filter: {
                input: "$todoList",
                as: "todo",
                cond: { $eq: ["$$todo.status", CHECKLIST_STATUS.COMPLETED] },
              },
            },
          },
          createdAt: 1,
          projectId: 1,
        },
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
    ]);
  };

  public static restoreDeletedChecklist = async (checklistId: mongoId) => {
    await Checklist.findByIdAndUpdate(checklistId, {
      $set: { status: CHECKLIST_STATUS.PENDING },
    });
  };

  public static todoUpdatePostId = async (
    todoListId: mongoId,
    postId: mongoId,
  ) => {
    return TodoList.findByIdAndUpdate(todoListId, {
      $set: { postId },
    });
  };

  public static findAllTodosV2 = async ({ checklistId }: ChecklistIdQuery) => {
    if (!isValidObjectId(checklistId)) return [];
    const userNamePipeline = getUserNamePipeline("completedBy");
    const query = {
      checklistId: ObjectId(checklistId),
      status: { $ne: CHECKLIST_STATUS.DELETED },
    };
    return TodoList.aggregate([
      {
        $match: query,
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "posts",
          let: { postId: "$postId" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$postId"] } } },
            {
              $lookup: {
                from: "postfiles",
                let: { postId: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ["$postId", "$$postId"] },
                      status: CURRENT_STATUS.ACTIVE,
                    },
                  },
                  { $sort: { position: 1 as const, createdAt: 1 as const } },
                ],
                as: "files",
              },
            },
          ],
          as: "postData",
        },
      },
      {
        $lookup: {
          from: "todolistimages",
          localField: "_id",
          foreignField: "todoListId",
          as: "legacyImages",
        },
      },
      {
        $addFields: {
          images: {
            $cond: {
              if: {
                $and: [
                  { $ifNull: ["$postId", false] },
                  { $gt: [{ $size: "$postData" }, 0] },
                ],
              },
              then: {
                $map: {
                  input: { $arrayElemAt: ["$postData.files", 0] },
                  as: "file",
                  in: {
                    _id: "$$file._id",
                    url: "$$file.url",
                    fileType: "$$file.fileType",
                    size: "$$file.size",
                  },
                },
              },
              else: {
                $map: {
                  input: "$legacyImages",
                  as: "img",
                  in: {
                    _id: "$$img._id",
                    url: "$$img.imageData.url",
                    fileType: "$$img.imageData.fileType",
                    size: "$$img.imageData.size",
                  },
                },
              },
            },
          },
        },
      },
      {
        $project: {
          name: 1,
          status: 1,
          completedAt: 1,
          completedBy: {
            _id: "$completedBy",
            userName: "$userName",
          },
          sortOrder: 1,
          checklistId: 1,
          createdAt: 1,
          images: 1,
          description: 1,
          areImagesMandatory: 1,
          questions: 1,
          taskImages: 1,
          postId: 1,
        },
      },
      {
        $sort: {
          sortOrder: 1,
          createdAt: -1,
        },
      },
    ]);
  };

  // Optimized version of findAllTodosV2 with improved performance
  public static findAllTodosV3 = async (
    { checklistId }: ChecklistIdQuery,
    projectId: mongoId,
    companyId: mongoId,
  ) => {
    if (!isValidObjectId(checklistId)) return [];

    const query = {
      checklistId: ObjectId(checklistId),
      status: { $ne: CHECKLIST_STATUS.DELETED },
    };

    return TodoList.aggregate([
      {
        $match: query,
      },
      // Sort early to use index efficiently
      {
        $sort: {
          sortOrder: 1,
          createdAt: -1,
        },
      },
      // Only lookup user data if completedBy exists
      {
        $lookup: {
          from: "users",
          let: { completedById: "$completedBy" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: ["$$completedById", null] },
                    { $eq: ["$_id", "$$completedById"] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 1,
                firstName: "$name.first",
                lastName: "$name.last",
              },
            },
          ],
          as: "completedByUser",
        },
      },
      // Conditional lookup for post files - only if postId exists
      {
        $lookup: {
          from: "postfiles",
          let: { postId: "$postId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$postId", "$$postId"] },
                projectId: projectId,
                companyId: companyId,
                // Without this, soft-deleted uploads still came back here while
                // every other postfiles reader (including details/v2 above)
                // filters them out — the source of web/mobile photo-count drift.
                status: CURRENT_STATUS.ACTIVE,
              },
            },
            { $sort: { position: 1, createdAt: 1 } },
            {
              $project: {
                _id: 1,
                url: 1,
                fileType: 1,
                size: 1,
                userId: 1,
                uploadedAt: 1,
                createdAt: 1,
              },
            },
          ],
          as: "postFiles",
        },
      },
      // Only lookup legacy images if postId doesn't exist
      {
        $lookup: {
          from: "todolistimages",
          let: { todoId: "$_id", hasPost: "$postId" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: [{ $ifNull: ["$$hasPost", null] }, null] },
                    { $eq: ["$todoListId", "$$todoId"] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 1,
                url: "$imageData.url",
                fileType: "$imageData.fileType",
                size: "$imageData.size",
                userId: "$imageData.userId",
                uploadedAt: "$imageData.uploadedAt",
                createdAt: 1,
              },
            },
          ],
          as: "legacyImages",
        },
      },
      {
        $project: {
          name: 1,
          status: 1,
          completedAt: 1,
          completedBy: {
            $cond: {
              if: { $gt: [{ $size: "$completedByUser" }, 0] },
              then: {
                _id: "$completedBy",
                // $concat yields null if ANY operand is null, and name.last is
                // optional for phone-signup users (the guest path) — coalesce
                // each part so a half-named user still shows a name.
                userName: {
                  $trim: {
                    input: {
                      $concat: [
                        {
                          $ifNull: [
                            { $arrayElemAt: ["$completedByUser.firstName", 0] },
                            "",
                          ],
                        },
                        " ",
                        {
                          $ifNull: [
                            { $arrayElemAt: ["$completedByUser.lastName", 0] },
                            "",
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              else: null,
            },
          },
          sortOrder: 1,
          checklistId: 1,
          createdAt: 1,
          images: {
            $cond: {
              if: { $gt: [{ $size: "$postFiles" }, 0] },
              then: "$postFiles",
              else: "$legacyImages",
            },
          },
          description: 1,
          areImagesMandatory: 1,
          questions: 1,
          taskImages: 1,
          postId: 1,
          // V2 typed fields (additive; V1 callers ignore these keys)
          fields: 1,
          responses: 1,
        },
      },
    ]);
  };

  public static getChecklistDetailById = async (checklistId: mongoId) => {
    return Checklist.findById(checklistId, {
      projectId: 1,
      companyId: 1,
      type: 1,
    });
  };

  // ---------------------------------------------------------------------------
  // V2 — typed fields (additive; V1 behavior untouched)
  // ---------------------------------------------------------------------------

  // Build a persistable `fields` array from a V2 task payload: drop fields whose
  // trimmed label is empty and strip unknown config keys off every survivor.
  private static buildFields = (
    fields: FieldDefinitionType[] | undefined,
  ): FieldDefinitionType[] => {
    if (!Array.isArray(fields)) return [];
    return fields
      .filter((f) => f && typeof f.label === "string" && f.label.trim() !== "")
      .map((f, index) => {
        const doc: FieldDefinitionType = {
          fieldType: f.fieldType,
          label: f.label.trim(),
          required: f.required === true,
          sortOrder: typeof f.sortOrder === "number" ? f.sortOrder : index,
          config: stripConfig(f.fieldType, f.config),
        };
        // Preserve existing _id so responses survive an update.
        if (f._id) doc._id = f._id;
        return doc;
      });
  };

  public static createV2 = async (
    userId: string,
    body: CreateChecklistV2Type,
    type: string,
  ) => {
    const { name, projectId, contributors, tasks, companyId } = body;

    const checklist = await Checklist.create({
      userId,
      projectId,
      name,
      type,
      contributors,
      companyId,
    });

    const documents = (tasks || [])
      .filter((task) => task && task.name)
      .map((task: TaskV2PayloadType) => {
        const document: Record<string, unknown> = {
          name: task.name,
          sortOrder: task.sortOrder ?? 0,
          checklistId: checklist._id,
          areImagesMandatory: task.photosRequired === true,
          fields: ChecklistHelper.buildFields(task.fields),
          responses: [],
        };
        if (task.description) document.description = task.description;
        if (task.taskImages?.length) document.taskImages = task.taskImages;
        return document;
      });

    if (documents.length) {
      await TodoList.insertMany(documents);
    }

    return checklist._id;
  };

  public static updateV2 = async (
    userId: string,
    body: UpdateChecklistV2Type,
  ) => {
    const { checklistId, name, contributors, tasks } = body;

    const checklistUpdate: { name?: string; contributors?: unknown[] } = {};
    if (name) checklistUpdate.name = name;
    checklistUpdate.contributors = contributors?.length ? contributors : [];
    await Checklist.findByIdAndUpdate(
      checklistId,
      { $set: checklistUpdate },
      { new: true },
    );

    // Replace semantics apply only when a tasks array is actually supplied —
    // a metadata-only update must never touch todos (an omitted array would
    // otherwise make the $nin below delete every todo in the checklist).
    if (!Array.isArray(tasks)) {
      return;
    }
    const incoming = tasks.filter((task) => task && task.name);

    // Delete stored todos absent from the payload (replace semantics).
    await TodoList.deleteMany({
      checklistId,
      _id: {
        $nin: incoming
          .filter((task) => task._id)
          .map((task) => ObjectId(String(task._id))),
      },
    });

    await Promise.all(
      incoming.map(async (task) => {
        const nextFields = ChecklistHelper.buildFields(task.fields);
        const areImagesMandatory = task.photosRequired === true;

        if (task._id) {
          // Scoped by checklistId (ownership is also pre-validated in the
          // controller) so a foreign task _id can never be adopted/rewritten.
          const existing = await TodoList.findOne({
            _id: ObjectId(String(task._id)),
            checklistId: ObjectId(String(checklistId)),
          });
          if (!existing) return;

          // Response preservation/pruning: keep responses whose fieldId still
          // exists among the new fields; drop the rest.
          const survivingFieldIds = new Set(
            nextFields.filter((f) => f._id).map((f) => String(f._id)),
          );
          const existingResponses: FieldResponseType[] = Array.isArray(
            existing.responses,
          )
            ? (existing.responses as unknown as FieldResponseType[])
            : [];
          const prunedResponses = existingResponses.filter((r) =>
            survivingFieldIds.has(String(r.fieldId)),
          );

          const set: Record<string, unknown> = {
            name: task.name,
            description: task.description || "",
            areImagesMandatory,
            sortOrder: task.sortOrder ?? 0,
            checklistId,
            fields: nextFields,
            responses: prunedResponses,
          };
          if (task.taskImages !== undefined) {
            set.taskImages = task.taskImages;
          }

          await TodoList.findByIdAndUpdate(
            task._id,
            { $set: set },
            { new: true },
          );

          // Completion photos (web viewer): replace semantics when the payload
          // carries `attachments`; omitted = stored photos untouched.
          const todoId = ObjectId(String(task._id));
          if (task.attachments !== undefined) {
            await ChecklistHelper.deleteTodoListImages(todoId);
            if (task.attachments.length) {
              await ChecklistHelper.todoUpdateImages(
                task.attachments.map((attachment) => {
                  // `uploadedBy` is a read-side projection from details/v3 —
                  // drop it and persist only the stored `userId` shape.
                  const imageData = { ...attachment };
                  delete imageData.uploadedBy;
                  return {
                    checklistId,
                    todoListId: todoId,
                    // These writes have replace semantics, so a photo someone
                    // else uploaded is rewritten here too — carry its original
                    // uploader across rather than reassigning every photo to
                    // whoever last touched the task (CRE-707).
                    imageData: {
                      ...imageData,
                      userId: ChecklistHelper.resolveUploaderId(
                        attachment,
                        userId,
                      ),
                    },
                  };
                }),
              );
            }
            // A linked completion post would shadow the replaced images in
            // details/v3 (postFiles wins over legacyImages) — unlink it; the
            // post itself stays in the project feed.
            if (existing.postId) {
              await ChecklistHelper.todoUpdatePostId(todoId, null);
            }
          }

          // Recompute status against the updated field/response set. The raw
          // doc doesn't embed completion photos, so resolve them (payload or
          // stored TodoListImages) for isTaskComplete's mandatory-photo arm.
          const refreshed = (await TodoList.findById(
            task._id,
          ).lean()) as TodoDocLike;
          const completionImages =
            task.attachments !== undefined
              ? task.attachments
              : refreshed?.postId
                ? undefined // postId already satisfies the photo arm
                : await ChecklistHelper.findTodoListImages({
                    todoListId: todoId,
                  });
          await ChecklistHelper.recomputeTodoStatus(
            completionImages !== undefined
              ? { ...refreshed, images: completionImages }
              : refreshed,
            userId,
          );
        } else {
          const created = await TodoList.create({
            name: task.name,
            description: task.description || "",
            areImagesMandatory,
            sortOrder: task.sortOrder ?? 0,
            checklistId,
            fields: nextFields,
            responses: [],
            ...(task.taskImages?.length && { taskImages: task.taskImages }),
          });
          if (task.attachments?.length) {
            await ChecklistHelper.todoUpdateImages(
              task.attachments.map((imageData) => ({
                checklistId,
                todoListId: created._id,
                imageData,
              })),
            );
          }
          const refreshed = (await TodoList.findById(
            created._id,
          ).lean()) as TodoDocLike;
          await ChecklistHelper.recomputeTodoStatus(
            task.attachments?.length
              ? { ...refreshed, images: task.attachments }
              : refreshed,
            userId,
          );
        }
      }),
    );
  };

  // Recompute a typed-field todo's status from its fields/responses. No-op for
  // field-less todos (they change status only via the manual status/v2 path).
  // Returns the resulting status.
  private static recomputeTodoStatus = async (
    todo: TodoDocLike,
    userId: string,
  ): Promise<string> => {
    if (!todo) return CHECKLIST_STATUS.PENDING;
    const fields = Array.isArray(todo.fields) ? todo.fields : [];
    if (fields.length === 0) {
      return todo.status || CHECKLIST_STATUS.PENDING;
    }

    const complete = isTaskComplete(todo);
    const currentStatus = todo.status || CHECKLIST_STATUS.PENDING;

    if (complete && currentStatus !== CHECKLIST_STATUS.COMPLETED) {
      await TodoList.findByIdAndUpdate(todo._id, {
        $set: {
          status: CHECKLIST_STATUS.COMPLETED,
          completedBy: ObjectId(String(userId)),
          completedAt: new Date(),
        },
      });
      await Checklist.findByIdAndUpdate(todo.checklistId, {
        $addToSet: { contributors: ObjectId(String(userId)) },
      });
      return CHECKLIST_STATUS.COMPLETED;
    }

    if (!complete && currentStatus === CHECKLIST_STATUS.COMPLETED) {
      // Revert to PENDING. Linked postId/photos are intentionally preserved.
      await TodoList.findByIdAndUpdate(todo._id, {
        $set: {
          status: CHECKLIST_STATUS.PENDING,
          completedBy: null,
          completedAt: null,
        },
      });
      return CHECKLIST_STATUS.PENDING;
    }

    return currentStatus;
  };

  // Map a legacy (V1) todo's `questions` into synthesized V2 text fields and
  // responses. Reuses each question's own subdoc _id as the fieldId so a
  // PATCH /v2/response can dual-write questions.$[el].value. Used by details/v3
  // and updateV2's return payload.
  public static mapLegacyTodo = (todo: {
    fields?: FieldDefinitionType[];
    responses?: FieldResponseType[];
    questions?: { _id?: unknown; label?: string; value?: string }[];
    areImagesMandatory?: boolean;
  }): {
    fields: FieldDefinitionType[];
    responses: FieldResponseType[];
  } => {
    const existingFields = Array.isArray(todo.fields) ? todo.fields : [];
    if (existingFields.length > 0) {
      return {
        fields: existingFields,
        responses: Array.isArray(todo.responses) ? todo.responses : [],
      };
    }

    const questions = Array.isArray(todo.questions) ? todo.questions : [];
    const fields: FieldDefinitionType[] = [];
    const responses: FieldResponseType[] = [];

    questions.forEach((question, index) => {
      if (!question || !question._id) return;
      const fieldId = question._id as string;
      fields.push({
        _id: fieldId,
        fieldType: FIELD_TYPE.TEXT,
        label: question.label || "",
        required: false,
        sortOrder: index,
        config: { multiline: true },
      });
      if (question.value) {
        responses.push({
          fieldId,
          fieldType: FIELD_TYPE.TEXT,
          value: question.value,
        });
      }
    });

    return { fields, responses };
  };

  // Fetch a checklist's todos and compute total/completed field counts across
  // it, applying legacy question->text-field mapping so V1 checklists report
  // progress too. Used by the PATCH /v2/response response.
  public static getChecklistFieldTotals = async (
    checklistId: mongoId,
  ): Promise<{ totalFields: number; completedFields: number }> => {
    const todos = await TodoList.find(
      {
        checklistId,
        status: { $ne: CHECKLIST_STATUS.DELETED },
      },
      { fields: 1, responses: 1, questions: 1 },
    ).lean();

    const mapped = todos.map((todo) => ChecklistHelper.mapLegacyTodo(todo));
    return ChecklistHelper.computeChecklistFieldTotals(mapped);
  };

  // Compute checklist-level field totals across a set of (already V2-mapped)
  // todos.
  public static computeChecklistFieldTotals = (
    todos: {
      fields?: FieldDefinitionType[];
      responses?: FieldResponseType[];
    }[],
  ): { totalFields: number; completedFields: number } => {
    let totalFields = 0;
    let completedFields = 0;
    for (const todo of todos) {
      const counts = countTodoFields(todo);
      totalFields += counts.totalFields;
      completedFields += counts.completedFields;
    }
    return { totalFields, completedFields };
  };

  // Fetch todos in the details/v3 shape: everything details/v2 returns, plus
  // `fields`, `responses`, and a computed `photosRequired`. Legacy mapping
  // (questions -> text fields) is applied in JS after the aggregation.
  public static findAllTodosV3WithFields = async (
    { checklistId }: ChecklistIdQuery,
    projectId: mongoId,
    companyId: mongoId,
  ) => {
    if (!isValidObjectId(checklistId)) return [];

    const todos = await ChecklistHelper.findAllTodosV3(
      { checklistId },
      projectId,
      companyId,
    );

    const mappedTodos = todos.map((todo) => {
      const mapped = ChecklistHelper.mapLegacyTodo(todo);
      return {
        ...todo,
        fields: mapped.fields,
        responses: mapped.responses,
        photosRequired: !!todo.areImagesMandatory,
      };
    });

    return ChecklistHelper.attachContributorNames(mappedTodos);
  };

  // Pick the uploader to persist for a completion photo: the attribution the
  // payload already carries (set by details/v3 on a previously stored photo),
  // otherwise the user performing the write — a genuinely new upload.
  private static resolveUploaderId = (
    imageData: {
      userId?: unknown;
      uploadedBy?: { _id?: unknown } | null;
    },
    fallbackUserId: string,
  ): mongoId => {
    const existing =
      (imageData?.uploadedBy && imageData.uploadedBy._id) ?? imageData?.userId;
    if (existing && isValidObjectId(String(existing))) {
      return ObjectId(String(existing));
    }
    return ObjectId(String(fallbackUserId));
  };

  // Resolve the per-field and per-photo contributor ids carried on todos into
  // {_id, userName} so clients can attribute individual answers and uploads
  // (CRE-707). Task-level `completedBy` is already hydrated by the aggregation.
  // One batched user query covers every id across the whole todo list.
  private static attachContributorNames = async <
    T extends {
      responses?: FieldResponseType[];
      images?: { userId?: mongoId | string | null }[];
    },
  >(
    todos: T[],
  ): Promise<T[]> => {
    const ids = new Set<string>();
    for (const todo of todos) {
      for (const response of todo.responses ?? []) {
        if (response.updatedBy) ids.add(String(response.updatedBy));
      }
      for (const image of todo.images ?? []) {
        if (image.userId) ids.add(String(image.userId));
      }
    }
    if (ids.size === 0) return todos;

    const users = (await User.find(
      { _id: { $in: Array.from(ids).map((id) => ObjectId(id)) } },
      { "name.first": 1, "name.last": 1, profileImage: 1 },
    ).lean()) as unknown as ContributorUserDoc[];

    const byId = new Map<string, ChecklistContributor>();
    for (const user of users) {
      byId.set(String(user._id), {
        _id: user._id,
        // Built in JS rather than via $concat: a missing first/last name makes
        // $concat return null, which would blank out the whole attribution.
        userName:
          [user.name?.first, user.name?.last].filter(Boolean).join(" ") || "",
        profileImage: user.profileImage ?? null,
      });
    }

    return todos.map((todo) => ({
      ...todo,
      responses: (todo.responses ?? []).map((response) => ({
        ...response,
        updatedByUser: response.updatedBy
          ? (byId.get(String(response.updatedBy)) ?? null)
          : null,
      })),
      images: (todo.images ?? []).map((image) => ({
        ...image,
        uploadedBy: image.userId
          ? (byId.get(String(image.userId)) ?? null)
          : null,
      })),
    }));
  };

  // Upsert a single field response and recompute the todo's status. Last write
  // wins by design (mobile offline replay). For legacy questions, additionally
  // dual-writes questions.$[el].value.
  public static saveFieldResponse = async (params: {
    todoListId: string;
    fieldId: string;
    fieldType: FIELD_TYPE;
    value: FieldResponseValue;
    userId: string;
    isLegacyQuestion: boolean;
  }): Promise<{
    status: string;
    completedBy: mongoId | null;
    completedAt: Date | null;
  }> => {
    const { todoListId, fieldId, fieldType, value, userId, isLegacyQuestion } =
      params;
    const todoId = ObjectId(todoListId);

    // Remove any existing response for this field, then push the new one.
    await TodoList.findByIdAndUpdate(todoId, {
      $pull: { responses: { fieldId: ObjectId(fieldId) } },
    });
    await TodoList.findByIdAndUpdate(todoId, {
      $push: {
        responses: {
          fieldId: ObjectId(fieldId),
          fieldType,
          value,
          updatedBy: ObjectId(String(userId)),
          updatedAt: new Date(),
        },
      },
    });

    // Legacy dual-write: keep questions.$[el].value in sync for V1 clients.
    if (isLegacyQuestion) {
      await TodoList.findByIdAndUpdate(
        todoId,
        {
          $set: {
            "questions.$[element].value": value == null ? "" : String(value),
          },
        },
        { arrayFilters: [{ "element._id": ObjectId(fieldId) }] },
      );
    }

    // Recompute status against the freshly written response set. For a legacy
    // question the synthesized (non-required) field never forces completion,
    // matching V1 semantics.
    const refreshed = (await TodoList.findById(
      todoId,
    ).lean()) as TodoDocLike | null;

    let status = refreshed?.status || CHECKLIST_STATUS.PENDING;
    if (
      refreshed &&
      Array.isArray(refreshed.fields) &&
      refreshed.fields.length
    ) {
      status = await ChecklistHelper.recomputeTodoStatus(refreshed, userId);
    }

    const final = (await TodoList.findById(todoId, {
      status: 1,
      completedBy: 1,
      completedAt: 1,
    }).lean()) as {
      status: string;
      completedBy: mongoId | null;
      completedAt: Date | null;
    } | null;

    return {
      status: final?.status || status,
      completedBy: final?.completedBy ?? null,
      completedAt: final?.completedAt ?? null,
    };
  };

  public static findMyChecklists = async (
    payload: FindMyChecklistsPayload,
    query: FindMyChecklistsQuery,
  ) => {
    const userNamePipeline = getUserNamePipeline();
    const projectNamePipeline = getProjectNamePipeline();

    const pipeline: any[] = [
      {
        $match: payload,
      },
      {
        $sort: {
          updatedAt: -1,
        },
      },
      { $skip: query.skip },
      { $limit: query.limit },
      ...userNamePipeline,
      ...projectNamePipeline,
      {
        $lookup: {
          from: "todolists",
          localField: "_id",
          foreignField: "checklistId",
          as: "todoList",
          pipeline: [
            { $match: { status: { $ne: CHECKLIST_STATUS.DELETED } } },
            {
              $group: {
                _id: null,
                totalTodo: {
                  $sum: 1,
                },
                completedTodo: {
                  $sum: {
                    $cond: [
                      { $eq: ["$status", CHECKLIST_STATUS.COMPLETED] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ],
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "contributors",
          foreignField: "_id",
          as: "contributorsInfo",
        },
      },
      {
        $project: {
          name: 1,
          userName: 1,
          contributors: {
            $map: {
              input: "$contributorsInfo",
              as: "contributor",
              in: {
                userName: {
                  $concat: [
                    "$$contributor.name.first",
                    " ",
                    "$$contributor.name.last",
                  ],
                },
                profileImage: "$$contributor.profileImage",
                _id: "$$contributor._id",
              },
            },
          },
          totalTodo: { $arrayElemAt: ["$todoList.totalTodo", 0] },
          completedTodo: { $arrayElemAt: ["$todoList.completedTodo", 0] },

          createdAt: 1,
          projectId: 1,
          projectName: 1,
        },
      },
    ];

    const [total, items] = await Promise.all([
      Checklist.aggregate([{ $match: payload }, { $count: "total" }]),
      Checklist.aggregate<MyChecklistType>(pipeline),
    ]);

    return {
      items,
      total,
      page: query.page,
      pageSize: query.limit,
      totalPages: Math.ceil((total[0]?.total || 0) / query.limit),
    };
  };
}
