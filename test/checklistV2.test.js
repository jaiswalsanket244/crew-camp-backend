const sinon = require("sinon");
const { expect } = require("chai");

// Load order matters for the compiled CJS output: mongoose + db must be
// required before route helpers (see test/integrations/integration.test.js).
require("mongoose");
require("../server/db");
const { TodoList, Checklist } = require("../server/db");
const { ChecklistHelper } = require("../server/routes/checklist/helper");
const { ChecklistRoutes } = require("../server/routes/checklist/routes");
const {
  validateFieldDefinition,
  validateResponseValue,
  isFieldAnswered,
  isTaskComplete,
} = require("../server/utils/helpers/checklistFields");
const {
  FIELD_TYPE,
  CHECKLIST_STATUS,
} = require("../server/utils/enums/checklist");

const CHECKLIST_ID = "507f1f77bcf86cd799439011";
const TODO_ID = "507f1f77bcf86cd799439012";
const FIELD_ID = "507f1f77bcf86cd799439013";
const USER_ID = "507f1f77bcf86cd799439014";

// ---------------------------------------------------------------------------
// 1. ChecklistFieldValidator — table-driven
// ---------------------------------------------------------------------------

describe("checklistFields.validateFieldDefinition", function () {
  const validCases = [
    { name: "checkbox", field: { fieldType: "checkbox", label: "Done?" } },
    {
      name: "text with config",
      field: {
        fieldType: "text",
        label: "Notes",
        config: { placeholder: "Type here", multiline: true },
      },
    },
    {
      name: "yes_no allowNA",
      field: { fieldType: "yes_no", label: "OK?", config: { allowNA: true } },
    },
    {
      name: "rating default (no maxRating)",
      field: { fieldType: "rating", label: "Quality" },
    },
    {
      name: "rating maxRating 10",
      field: {
        fieldType: "rating",
        label: "Quality",
        config: { maxRating: 10 },
      },
    },
    {
      name: "select with options",
      field: {
        fieldType: "select",
        label: "Pick",
        config: { options: [{ label: "A", value: "a" }] },
      },
    },
    {
      name: "multi_select with min/max",
      field: {
        fieldType: "multi_select",
        label: "Pick many",
        config: {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
          minSelections: 1,
          maxSelections: 2,
        },
      },
    },
    {
      name: "number with bounds",
      field: {
        fieldType: "number",
        label: "Width",
        config: { unit: "mm", min: 0, max: 50, decimalPlaces: 1 },
      },
    },
    { name: "date", field: { fieldType: "date", label: "When" } },
  ];

  validCases.forEach(({ name, field }) => {
    it(`accepts valid ${name}`, function () {
      expect(validateFieldDefinition(field)).to.equal(null);
    });
  });

  const invalidCases = [
    { name: "empty label", field: { fieldType: "text", label: "   " } },
    { name: "photo reserved", field: { fieldType: "photo", label: "Pic" } },
    { name: "unknown type", field: { fieldType: "bogus", label: "X" } },
    {
      name: "rating maxRating 6",
      field: { fieldType: "rating", label: "Q", config: { maxRating: 6 } },
    },
    {
      name: "select zero options",
      field: { fieldType: "select", label: "P", config: { options: [] } },
    },
    {
      name: "select duplicate values (case-insensitive)",
      field: {
        fieldType: "select",
        label: "P",
        config: {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "A" },
          ],
        },
      },
    },
    {
      name: "multi_select min > max",
      field: {
        fieldType: "multi_select",
        label: "P",
        config: {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
          minSelections: 2,
          maxSelections: 1,
        },
      },
    },
    {
      name: "multi_select max > options.length",
      field: {
        fieldType: "multi_select",
        label: "P",
        config: {
          options: [{ label: "A", value: "a" }],
          maxSelections: 5,
        },
      },
    },
    {
      name: "number min > max",
      field: {
        fieldType: "number",
        label: "N",
        config: { min: 10, max: 5 },
      },
    },
    {
      name: "number decimalPlaces 4",
      field: {
        fieldType: "number",
        label: "N",
        config: { decimalPlaces: 4 },
      },
    },
  ];

  invalidCases.forEach(({ name, field }) => {
    it(`rejects ${name}`, function () {
      expect(validateFieldDefinition(field)).to.be.a("string");
    });
  });
});

describe("checklistFields.validateResponseValue", function () {
  const cases = [
    // [description, field, value, expectValid]
    ["null always valid", { fieldType: "rating", label: "x" }, null, true],
    ["checkbox true", { fieldType: "checkbox", label: "x" }, true, true],
    ["checkbox non-bool", { fieldType: "checkbox", label: "x" }, "yes", false],
    ["text string", { fieldType: "text", label: "x" }, "hello", true],
    [
      "text too long",
      { fieldType: "text", label: "x" },
      "a".repeat(10001),
      false,
    ],
    [
      "yes_no yes",
      { fieldType: "yes_no", label: "x", config: {} },
      "yes",
      true,
    ],
    [
      "yes_no na without allowNA",
      { fieldType: "yes_no", label: "x", config: {} },
      "na",
      false,
    ],
    [
      "yes_no na with allowNA",
      { fieldType: "yes_no", label: "x", config: { allowNA: true } },
      "na",
      true,
    ],
    [
      "rating in bounds (default 5)",
      { fieldType: "rating", label: "x", config: {} },
      5,
      true,
    ],
    [
      "rating out of bounds",
      { fieldType: "rating", label: "x", config: {} },
      6,
      false,
    ],
    [
      "rating non-integer",
      { fieldType: "rating", label: "x", config: {} },
      3.5,
      false,
    ],
    [
      "select member",
      {
        fieldType: "select",
        label: "x",
        config: { options: [{ label: "A", value: "a" }] },
      },
      "a",
      true,
    ],
    [
      "select non-member",
      {
        fieldType: "select",
        label: "x",
        config: { options: [{ label: "A", value: "a" }] },
      },
      "z",
      false,
    ],
    [
      "multi_select valid subset",
      {
        fieldType: "multi_select",
        label: "x",
        config: {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
        },
      },
      ["a", "b"],
      true,
    ],
    [
      "multi_select duplicate",
      {
        fieldType: "multi_select",
        label: "x",
        config: { options: [{ label: "A", value: "a" }] },
      },
      ["a", "a"],
      false,
    ],
    [
      "multi_select below min (non-empty)",
      {
        fieldType: "multi_select",
        label: "x",
        config: {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
          minSelections: 2,
        },
      },
      ["a"],
      false,
    ],
    [
      "multi_select empty array always allowed (cleared)",
      {
        fieldType: "multi_select",
        label: "x",
        config: {
          options: [{ label: "A", value: "a" }],
          minSelections: 1,
        },
      },
      [],
      true,
    ],
    [
      "multi_select above max",
      {
        fieldType: "multi_select",
        label: "x",
        config: {
          options: [
            { label: "A", value: "a" },
            { label: "B", value: "b" },
          ],
          maxSelections: 1,
        },
      },
      ["a", "b"],
      false,
    ],
    [
      "number within bounds",
      {
        fieldType: "number",
        label: "x",
        config: { min: 0, max: 50, decimalPlaces: 1 },
      },
      1.2,
      true,
    ],
    [
      "number below min",
      { fieldType: "number", label: "x", config: { min: 0, max: 50 } },
      -1,
      false,
    ],
    [
      "number above max",
      { fieldType: "number", label: "x", config: { min: 0, max: 50 } },
      51,
      false,
    ],
    [
      "number too many decimals",
      { fieldType: "number", label: "x", config: { decimalPlaces: 1 } },
      1.25,
      false,
    ],
    ["date valid", { fieldType: "date", label: "x" }, "2026-07-10", true],
    ["date bad format", { fieldType: "date", label: "x" }, "07/10/2026", false],
    ["date impossible", { fieldType: "date", label: "x" }, "2026-02-30", false],
  ];

  cases.forEach(([desc, field, value, expectValid]) => {
    it(`${expectValid ? "accepts" : "rejects"} ${desc}`, function () {
      const result = validateResponseValue(field, value);
      if (expectValid) expect(result).to.equal(null);
      else expect(result).to.be.a("string");
    });
  });
});

describe("checklistFields.isFieldAnswered / isTaskComplete", function () {
  it("checkbox answered only when true", function () {
    const f = { _id: "f1", fieldType: "checkbox", label: "x" };
    expect(isFieldAnswered(f, { fieldId: "f1", value: true })).to.equal(true);
    expect(isFieldAnswered(f, { fieldId: "f1", value: false })).to.equal(false);
    expect(isFieldAnswered(f, undefined)).to.equal(false);
  });

  it("text answered only when non-empty after trim", function () {
    const f = { _id: "f1", fieldType: "text", label: "x" };
    expect(isFieldAnswered(f, { fieldId: "f1", value: "  " })).to.equal(false);
    expect(isFieldAnswered(f, { fieldId: "f1", value: "hi" })).to.equal(true);
  });

  it("multi_select answered only when non-empty array", function () {
    const f = { _id: "f1", fieldType: "multi_select", label: "x" };
    expect(isFieldAnswered(f, { fieldId: "f1", value: [] })).to.equal(false);
    expect(isFieldAnswered(f, { fieldId: "f1", value: ["a"] })).to.equal(true);
  });

  it("isTaskComplete: all required answered", function () {
    const todo = {
      fields: [
        { _id: "f1", fieldType: "yes_no", label: "a", required: true },
        { _id: "f2", fieldType: "text", label: "b", required: false },
      ],
      responses: [{ fieldId: "f1", value: "yes" }],
      areImagesMandatory: false,
    };
    expect(isTaskComplete(todo)).to.equal(true);
  });

  it("isTaskComplete: false when a required field unanswered", function () {
    const todo = {
      fields: [
        { _id: "f1", fieldType: "yes_no", label: "a", required: true },
        { _id: "f2", fieldType: "text", label: "b", required: true },
      ],
      responses: [{ fieldId: "f1", value: "yes" }],
      areImagesMandatory: false,
    };
    expect(isTaskComplete(todo)).to.equal(false);
  });

  it("isTaskComplete: false when photos mandatory and none present", function () {
    const todo = {
      fields: [{ _id: "f1", fieldType: "yes_no", label: "a", required: true }],
      responses: [{ fieldId: "f1", value: "yes" }],
      areImagesMandatory: true,
    };
    expect(isTaskComplete(todo)).to.equal(false);
    expect(isTaskComplete({ ...todo, postId: "p1" })).to.equal(true);
    expect(isTaskComplete({ ...todo, images: [{}] })).to.equal(true);
  });
});

// ---------------------------------------------------------------------------
// 2. saveFieldResponse helper — upsert / auto-complete / revert / legacy
// ---------------------------------------------------------------------------

describe("ChecklistHelper.saveFieldResponse", function () {
  let updateStub;
  let checklistUpdateStub;
  let findByIdStub;

  afterEach(function () {
    sinon.restore();
  });

  // Builds a findById mock that returns a sequence of lean/projected docs.
  function stubFindByIdSequence(docs) {
    let call = 0;
    return sinon.stub(TodoList, "findById").callsFake(function () {
      const doc = docs[Math.min(call, docs.length - 1)];
      call += 1;
      return {
        lean: () => Promise.resolve(doc),
        // Projected variant (final read) — same doc.
        then: undefined,
      };
    });
  }

  it("upserts (pull then push) a response and does not duplicate", async function () {
    updateStub = sinon.stub(TodoList, "findByIdAndUpdate").resolves({});
    checklistUpdateStub = sinon
      .stub(Checklist, "findByIdAndUpdate")
      .resolves({});

    // After write, todo has one field (not required) → stays PENDING.
    const refreshed = {
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      status: CHECKLIST_STATUS.PENDING,
      fields: [{ _id: FIELD_ID, fieldType: FIELD_TYPE.TEXT, required: false }],
      responses: [{ fieldId: FIELD_ID, value: "hi" }],
    };
    findByIdStub = sinon.stub(TodoList, "findById");
    findByIdStub.onCall(0).returns({ lean: () => Promise.resolve(refreshed) });
    findByIdStub.onCall(1).returns({
      lean: () =>
        Promise.resolve({
          status: CHECKLIST_STATUS.PENDING,
          completedBy: null,
          completedAt: null,
        }),
    });

    const result = await ChecklistHelper.saveFieldResponse({
      todoListId: TODO_ID,
      fieldId: FIELD_ID,
      fieldType: FIELD_TYPE.TEXT,
      value: "hi",
      userId: USER_ID,
      isLegacyQuestion: false,
    });

    // First two update calls are the $pull then $push (upsert, no duplicate).
    expect(updateStub.getCall(0).args[1]).to.have.property("$pull");
    expect(updateStub.getCall(1).args[1]).to.have.property("$push");
    expect(result.status).to.equal(CHECKLIST_STATUS.PENDING);
  });

  it("auto-completes when the last required field is answered", async function () {
    updateStub = sinon.stub(TodoList, "findByIdAndUpdate").resolves({});
    checklistUpdateStub = sinon
      .stub(Checklist, "findByIdAndUpdate")
      .resolves({});

    const refreshed = {
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      status: CHECKLIST_STATUS.PENDING,
      areImagesMandatory: false,
      fields: [{ _id: FIELD_ID, fieldType: FIELD_TYPE.YES_NO, required: true }],
      responses: [{ fieldId: FIELD_ID, value: "yes" }],
    };
    findByIdStub = sinon.stub(TodoList, "findById");
    findByIdStub.onCall(0).returns({ lean: () => Promise.resolve(refreshed) });
    findByIdStub.onCall(1).returns({
      lean: () =>
        Promise.resolve({
          status: CHECKLIST_STATUS.COMPLETED,
          completedBy: USER_ID,
          completedAt: new Date(),
        }),
    });

    const result = await ChecklistHelper.saveFieldResponse({
      todoListId: TODO_ID,
      fieldId: FIELD_ID,
      fieldType: FIELD_TYPE.YES_NO,
      value: "yes",
      userId: USER_ID,
      isLegacyQuestion: false,
    });

    // One of the update calls flips status to COMPLETED with completedBy set.
    const completeCall = updateStub
      .getCalls()
      .find(
        (c) =>
          c.args[1].$set &&
          c.args[1].$set.status === CHECKLIST_STATUS.COMPLETED,
      );
    expect(completeCall, "a COMPLETED update should be issued").to.exist;
    expect(completeCall.args[1].$set.completedBy).to.exist;
    expect(result.status).to.equal(CHECKLIST_STATUS.COMPLETED);
  });

  it("auto-reverts to PENDING when a required answer is cleared", async function () {
    updateStub = sinon.stub(TodoList, "findByIdAndUpdate").resolves({});
    checklistUpdateStub = sinon
      .stub(Checklist, "findByIdAndUpdate")
      .resolves({});

    const refreshed = {
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      status: CHECKLIST_STATUS.COMPLETED,
      areImagesMandatory: false,
      fields: [{ _id: FIELD_ID, fieldType: FIELD_TYPE.YES_NO, required: true }],
      responses: [{ fieldId: FIELD_ID, value: null }],
    };
    findByIdStub = sinon.stub(TodoList, "findById");
    findByIdStub.onCall(0).returns({ lean: () => Promise.resolve(refreshed) });
    findByIdStub.onCall(1).returns({
      lean: () =>
        Promise.resolve({
          status: CHECKLIST_STATUS.PENDING,
          completedBy: null,
          completedAt: null,
        }),
    });

    const result = await ChecklistHelper.saveFieldResponse({
      todoListId: TODO_ID,
      fieldId: FIELD_ID,
      fieldType: FIELD_TYPE.YES_NO,
      value: null,
      userId: USER_ID,
      isLegacyQuestion: false,
    });

    const revertCall = updateStub
      .getCalls()
      .find(
        (c) =>
          c.args[1].$set &&
          c.args[1].$set.status === CHECKLIST_STATUS.PENDING &&
          c.args[1].$set.completedBy === null,
      );
    expect(revertCall, "a PENDING revert update should be issued").to.exist;
    expect(result.status).to.equal(CHECKLIST_STATUS.PENDING);
  });

  it("dual-writes questions.$[el].value for a legacy question", async function () {
    updateStub = sinon.stub(TodoList, "findByIdAndUpdate").resolves({});
    sinon.stub(Checklist, "findByIdAndUpdate").resolves({});

    const refreshed = {
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      status: CHECKLIST_STATUS.PENDING,
      // legacy: no V2 fields -> status untouched by recompute
      fields: [],
      responses: [{ fieldId: FIELD_ID, value: "answer" }],
      questions: [{ _id: FIELD_ID, label: "Q", value: "answer" }],
    };
    findByIdStub = sinon.stub(TodoList, "findById");
    findByIdStub.onCall(0).returns({ lean: () => Promise.resolve(refreshed) });
    findByIdStub.onCall(1).returns({
      lean: () =>
        Promise.resolve({
          status: CHECKLIST_STATUS.PENDING,
          completedBy: null,
          completedAt: null,
        }),
    });

    await ChecklistHelper.saveFieldResponse({
      todoListId: TODO_ID,
      fieldId: FIELD_ID,
      fieldType: FIELD_TYPE.TEXT,
      value: "answer",
      userId: USER_ID,
      isLegacyQuestion: true,
    });

    const dualWrite = updateStub
      .getCalls()
      .find(
        (c) =>
          c.args[1].$set &&
          c.args[1].$set["questions.$[element].value"] === "answer",
      );
    expect(dualWrite, "questions dual-write should be issued").to.exist;
    // arrayFilters targeting the question _id must be present.
    expect(dualWrite.args[2]).to.have.property("arrayFilters");
  });
});

// ---------------------------------------------------------------------------
// 3. createV2 / updateV2 — persistence + mapping + preservation/pruning
// ---------------------------------------------------------------------------

describe("ChecklistHelper.createV2", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("maps photosRequired -> areImagesMandatory, persists fields, drops blank labels", async function () {
    sinon.stub(Checklist, "create").resolves({ _id: CHECKLIST_ID });
    const insertStub = sinon.stub(TodoList, "insertMany").resolves([]);

    await ChecklistHelper.createV2(
      USER_ID,
      {
        name: "CL",
        projectId: CHECKLIST_ID,
        companyId: CHECKLIST_ID,
        contributors: [],
        tasks: [
          {
            name: "Task",
            photosRequired: true,
            sortOrder: 0,
            fields: [
              { fieldType: FIELD_TYPE.TEXT, label: "Keep", required: true },
              { fieldType: FIELD_TYPE.TEXT, label: "   " }, // dropped
            ],
          },
        ],
      },
      "checklist",
    );

    expect(insertStub.calledOnce).to.equal(true);
    const doc = insertStub.firstCall.args[0][0];
    expect(doc.areImagesMandatory).to.equal(true);
    expect(doc.fields).to.have.lengthOf(1);
    expect(doc.fields[0].label).to.equal("Keep");
    expect(doc.responses).to.deep.equal([]);
  });
});

describe("ChecklistHelper.updateV2 — response preservation & pruning", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("preserves responses for surviving fields and prunes removed ones", async function () {
    sinon.stub(Checklist, "findByIdAndUpdate").resolves({});
    sinon.stub(TodoList, "deleteMany").resolves({});
    const updateStub = sinon.stub(TodoList, "findByIdAndUpdate").resolves({});

    const SURVIVING_FIELD = "507f1f77bcf86cd799439021";
    const REMOVED_FIELD = "507f1f77bcf86cd799439022";

    const existing = {
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      status: CHECKLIST_STATUS.PENDING,
      fields: [],
      responses: [
        { fieldId: SURVIVING_FIELD, fieldType: FIELD_TYPE.TEXT, value: "keep" },
        { fieldId: REMOVED_FIELD, fieldType: FIELD_TYPE.TEXT, value: "drop" },
      ],
    };

    // The loop now loads the existing todo scoped by {_id, checklistId}.
    sinon.stub(TodoList, "findOne").resolves(existing);
    const findByIdStub = sinon.stub(TodoList, "findById");
    // Recompute lean read after the $set.
    findByIdStub.onCall(0).returns({
      lean: () =>
        Promise.resolve({
          _id: TODO_ID,
          checklistId: CHECKLIST_ID,
          status: CHECKLIST_STATUS.PENDING,
          fields: [
            {
              _id: SURVIVING_FIELD,
              fieldType: FIELD_TYPE.TEXT,
              required: false,
            },
          ],
          responses: [
            {
              fieldId: SURVIVING_FIELD,
              fieldType: FIELD_TYPE.TEXT,
              value: "keep",
            },
          ],
        }),
    });

    await ChecklistHelper.updateV2(USER_ID, {
      checklistId: CHECKLIST_ID,
      name: "CL",
      contributors: [],
      tasks: [
        {
          _id: TODO_ID,
          name: "Task",
          photosRequired: false,
          sortOrder: 0,
          fields: [
            {
              _id: SURVIVING_FIELD,
              fieldType: FIELD_TYPE.TEXT,
              label: "Kept",
              required: false,
            },
          ],
        },
      ],
    });

    // The $set update carries only the surviving field's response.
    const setCall = updateStub
      .getCalls()
      .find((c) => c.args[1].$set && c.args[1].$set.responses);
    expect(setCall, "a $set update with responses should occur").to.exist;
    const responses = setCall.args[1].$set.responses;
    expect(responses).to.have.lengthOf(1);
    expect(String(responses[0].fieldId)).to.equal(SURVIVING_FIELD);
  });
});

describe("ChecklistHelper.updateV2 — safety guards (Codex review)", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("never deletes todos when tasks is omitted (metadata-only update)", async function () {
    sinon.stub(Checklist, "findByIdAndUpdate").resolves({});
    const deleteStub = sinon.stub(TodoList, "deleteMany").resolves({});

    await ChecklistHelper.updateV2(USER_ID, {
      checklistId: CHECKLIST_ID,
      name: "Renamed only",
      contributors: [],
      // tasks intentionally omitted
    });

    expect(deleteStub.called).to.equal(false);
  });

  it("loads existing tasks scoped by checklistId (no foreign-task adoption)", async function () {
    sinon.stub(Checklist, "findByIdAndUpdate").resolves({});
    sinon.stub(TodoList, "deleteMany").resolves({});
    const findOneStub = sinon.stub(TodoList, "findOne").resolves(null);

    await ChecklistHelper.updateV2(USER_ID, {
      checklistId: CHECKLIST_ID,
      name: "CL",
      contributors: [],
      tasks: [
        { _id: TODO_ID, name: "Task", photosRequired: false, sortOrder: 0 },
      ],
    });

    expect(findOneStub.calledOnce).to.equal(true);
    const query = findOneStub.firstCall.args[0];
    expect(String(query._id)).to.equal(String(TODO_ID));
    expect(String(query.checklistId)).to.equal(String(CHECKLIST_ID));
  });
});

describe("ChecklistHelper.verifyTaskOwnership", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("passes when every task._id belongs to the checklist (and when no ids)", async function () {
    sinon.stub(TodoList, "countDocuments").resolves(1);
    expect(
      await ChecklistHelper.verifyTaskOwnership(CHECKLIST_ID, [
        { _id: TODO_ID, name: "T" },
        { name: "new task, no id" },
      ]),
    ).to.equal(null);
    expect(
      await ChecklistHelper.verifyTaskOwnership(CHECKLIST_ID, [
        { name: "only new" },
      ]),
    ).to.equal(null);
    expect(
      await ChecklistHelper.verifyTaskOwnership(CHECKLIST_ID, undefined),
    ).to.equal(null);
  });

  it("rejects when a task._id belongs to another checklist", async function () {
    sinon.stub(TodoList, "countDocuments").resolves(0);
    const error = await ChecklistHelper.verifyTaskOwnership(CHECKLIST_ID, [
      { _id: TODO_ID, name: "hijack attempt" },
    ]);
    expect(error).to.be.a("string");
  });
});

describe("ChecklistHelper.findTodoInChecklist", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("scopes the lookup by both todoListId and checklistId", async function () {
    const findOneStub = sinon.stub(TodoList, "findOne").resolves(null);
    await ChecklistHelper.findTodoInChecklist(TODO_ID, CHECKLIST_ID);
    const query = findOneStub.firstCall.args[0];
    expect(String(query._id)).to.equal(String(TODO_ID));
    expect(String(query.checklistId)).to.equal(String(CHECKLIST_ID));
  });
});

// ---------------------------------------------------------------------------
// 4. details/v3 legacy mapping
// ---------------------------------------------------------------------------

describe("ChecklistHelper.mapLegacyTodo", function () {
  it("synthesizes text fields from questions, reusing the question _id", function () {
    const mapped = ChecklistHelper.mapLegacyTodo({
      fields: [],
      responses: [],
      questions: [
        { _id: "q1", label: "First", value: "A" },
        { _id: "q2", label: "Second" }, // no value -> no response
      ],
    });

    expect(mapped.fields).to.have.lengthOf(2);
    expect(mapped.fields[0]._id).to.equal("q1");
    expect(mapped.fields[0].fieldType).to.equal(FIELD_TYPE.TEXT);
    expect(mapped.fields[0].config).to.deep.equal({ multiline: true });
    // response only for the answered question
    expect(mapped.responses).to.have.lengthOf(1);
    expect(mapped.responses[0].fieldId).to.equal("q1");
    expect(mapped.responses[0].value).to.equal("A");
  });

  it("passes typed V2 fields through untouched", function () {
    const fields = [{ _id: "f1", fieldType: FIELD_TYPE.RATING, label: "R" }];
    const responses = [{ fieldId: "f1", value: 5 }];
    const mapped = ChecklistHelper.mapLegacyTodo({
      fields,
      responses,
      questions: [{ _id: "q1", label: "ignored" }],
    });
    expect(mapped.fields).to.equal(fields);
    expect(mapped.responses).to.equal(responses);
  });
});

describe("ChecklistHelper.computeChecklistFieldTotals", function () {
  it("sums answered/total across mapped todos", function () {
    const totals = ChecklistHelper.computeChecklistFieldTotals([
      {
        fields: [
          { _id: "a", fieldType: FIELD_TYPE.TEXT },
          { _id: "b", fieldType: FIELD_TYPE.TEXT },
        ],
        responses: [{ fieldId: "a", value: "x" }],
      },
      {
        fields: [{ _id: "c", fieldType: FIELD_TYPE.CHECKBOX }],
        responses: [{ fieldId: "c", value: true }],
      },
    ]);
    expect(totals.totalFields).to.equal(3);
    expect(totals.completedFields).to.equal(2);
  });
});

// ---------------------------------------------------------------------------
// 5. status/v2 guard regression — manual complete rejected when required typed
//    fields unanswered; still works for field-less todos.
// ---------------------------------------------------------------------------

describe("ChecklistRoutes.updateStatusV2 — typed-field guard", function () {
  afterEach(function () {
    sinon.restore();
  });

  function mockRes() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  const baseReq = (overrides) => ({
    body: { todoListId: TODO_ID, status: CHECKLIST_STATUS.COMPLETED },
    query: {},
    user: { _id: USER_ID, companyId: CHECKLIST_ID },
    ...overrides,
  });

  it("rejects manual COMPLETED with 422 when a required typed field is unanswered", async function () {
    sinon.stub(ChecklistHelper, "findTodo").resolves({
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      areImagesMandatory: false,
      fields: [
        {
          _id: FIELD_ID,
          fieldType: FIELD_TYPE.YES_NO,
          label: "Q",
          required: true,
        },
      ],
      responses: [],
    });
    sinon.stub(Checklist, "findById").resolves({
      _id: CHECKLIST_ID,
      projectId: CHECKLIST_ID,
      name: "CL",
    });
    const todoUpdateStub = sinon
      .stub(ChecklistHelper, "todoUpdate")
      .resolves({});

    const req = baseReq();
    const res = mockRes();
    await ChecklistRoutes.updateStatusV2(req, res, (e) => {
      throw e;
    });

    expect(res.statusCode).to.equal(422);
    expect(res.body.message).to.match(/Answer required fields/i);
    expect(todoUpdateStub.called).to.equal(false);
  });

  it("allows manual COMPLETED for a field-less todo (V1 behavior preserved)", async function () {
    sinon.stub(ChecklistHelper, "findTodo").resolves({
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      areImagesMandatory: false,
      fields: [],
      responses: [],
    });
    sinon.stub(Checklist, "findById").resolves({
      _id: CHECKLIST_ID,
      projectId: CHECKLIST_ID,
      name: "CL",
    });
    const todoUpdateStub = sinon
      .stub(ChecklistHelper, "todoUpdate")
      .resolves({});

    const req = baseReq();
    const res = mockRes();
    await ChecklistRoutes.updateStatusV2(req, res, (e) => {
      throw e;
    });

    expect(res.statusCode).to.equal(200);
    expect(todoUpdateStub.calledOnce).to.equal(true);
  });

  it("allows manual COMPLETED once all required typed fields are answered", async function () {
    sinon.stub(ChecklistHelper, "findTodo").resolves({
      _id: TODO_ID,
      checklistId: CHECKLIST_ID,
      areImagesMandatory: false,
      fields: [
        {
          _id: FIELD_ID,
          fieldType: FIELD_TYPE.YES_NO,
          label: "Q",
          required: true,
        },
      ],
      responses: [
        { fieldId: FIELD_ID, fieldType: FIELD_TYPE.YES_NO, value: "yes" },
      ],
    });
    sinon.stub(Checklist, "findById").resolves({
      _id: CHECKLIST_ID,
      projectId: CHECKLIST_ID,
      name: "CL",
    });
    const todoUpdateStub = sinon
      .stub(ChecklistHelper, "todoUpdate")
      .resolves({});

    const req = baseReq();
    const res = mockRes();
    await ChecklistRoutes.updateStatusV2(req, res, (e) => {
      throw e;
    });

    expect(res.statusCode).to.equal(200);
    expect(todoUpdateStub.calledOnce).to.equal(true);
  });
});
