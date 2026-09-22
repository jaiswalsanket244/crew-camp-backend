const sinon = require("sinon");
const { expect } = require("chai");
// mongoose + db must be required before route helpers (compiled-CJS load order).
require("mongoose");
require("../server/db");
const { TodoList, Checklist } = require("../server/db");
const { ChecklistHelper } = require("../server/routes/checklist/helper");

// Valid 24-char hex strings — Mongoose's ObjectId() throws on anything else,
// and `put()` runs ObjectId() on every update[*]._id before any stub catches it.
const CHECKLIST_ID = "507f1f77bcf86cd799439011";
const TODO_ID = "507f1f77bcf86cd799439012";

describe("ChecklistHelper.put — taskImages persistence", function () {
  let findByIdAndUpdateStub;
  let createStub;
  let deleteManyStub;
  let checklistUpdateStub;

  beforeEach(function () {
    findByIdAndUpdateStub = sinon
      .stub(TodoList, "findByIdAndUpdate")
      .resolves({});
    createStub = sinon.stub(TodoList, "create").resolves({});
    deleteManyStub = sinon.stub(TodoList, "deleteMany").resolves({});
    checklistUpdateStub = sinon
      .stub(Checklist, "findByIdAndUpdate")
      .resolves({});
  });

  afterEach(function () {
    sinon.restore();
  });

  it("persists taskImages when updating an existing task (regression for the bug)", async function () {
    const taskImages = [
      {
        imageData: {
          url: "https://example.com/a.jpg",
          fileType: "image",
          size: { width: 10, height: 10 },
        },
      },
    ];

    await ChecklistHelper.put({
      checklistId: CHECKLIST_ID,
      update: [
        {
          _id: TODO_ID,
          name: "task one",
          sortOrder: 0,
          taskImages,
        },
      ],
    });

    expect(findByIdAndUpdateStub.calledOnce).to.equal(true);
    expect(
      findByIdAndUpdateStub.firstCall.args[1].$set.taskImages,
    ).to.deep.equal(taskImages);
  });

  it("persists taskImages when creating a new task during edit", async function () {
    const taskImages = [
      {
        imageData: {
          url: "https://example.com/b.jpg",
          fileType: "image",
          size: { width: 10, height: 10 },
        },
      },
    ];

    await ChecklistHelper.put({
      checklistId: CHECKLIST_ID,
      update: [
        {
          name: "new task without id",
          sortOrder: 0,
          taskImages,
        },
      ],
    });

    expect(createStub.calledOnce).to.equal(true);
    expect(createStub.firstCall.args[0].taskImages).to.deep.equal(taskImages);
  });

  it("preserves DB photos when an old client omits taskImages on an existing task", async function () {
    await ChecklistHelper.put({
      checklistId: CHECKLIST_ID,
      update: [
        {
          _id: TODO_ID,
          name: "task one",
          sortOrder: 0,
          // no taskImages field
        },
      ],
    });

    expect(findByIdAndUpdateStub.calledOnce).to.equal(true);
    expect(findByIdAndUpdateStub.firstCall.args[1].$set).to.not.have.property(
      "taskImages",
    );
  });

  it("honors an explicit empty array (user removed all photos from a task)", async function () {
    await ChecklistHelper.put({
      checklistId: CHECKLIST_ID,
      update: [
        {
          _id: TODO_ID,
          name: "task one",
          sortOrder: 0,
          taskImages: [],
        },
      ],
    });

    expect(findByIdAndUpdateStub.calledOnce).to.equal(true);
    expect(
      findByIdAndUpdateStub.firstCall.args[1].$set.taskImages,
    ).to.deep.equal([]);
  });
});
