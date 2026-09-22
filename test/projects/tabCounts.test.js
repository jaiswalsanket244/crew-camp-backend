const sinon = require("sinon");
const { expect } = require("chai");
const {
  Files,
  Checklist,
  ProjectTasks,
  ProjectReports,
  ProjectNotes,
  PostFiles,
} = require("../../lib/db");
const { FilesHelper } = require("../../lib/routes/file/helper");
const { ChecklistHelper } = require("../../lib/routes/checklist/helper");
const { ProjectTasksHelper } = require("../../lib/routes/projectTasks/helper");
const {
  ProjectReportsHelpers,
} = require("../../lib/routes/projectReport/helpers");
const { ProjectNotesHelper } = require("../../lib/routes/projectNotes/helper");
const { PostsHelper } = require("../../lib/routes/posts/helper");

// Valid 24-char hex strings — Mongoose's ObjectId() throws on anything else.
const PROJECT_ID = "507f1f77bcf86cd799439011";
const COMPANY_ID = "507f1f77bcf86cd799439012";
const USER_ID = "507f1f77bcf86cd799439013";

// These tests pin each tab-count filter to the matching tab's own list query.
// They are the regression guard for the config traps the eng review surfaced:
// the lowercase "deleted" report status, the checklist template exclusion, and
// the role-scoped file visibility (no restricted-file leak).
describe("Project tab-count filters", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("Photos: counts ACTIVE postfiles for the project (matches Uploads grid)", async function () {
    const stub = sinon.stub(PostFiles, "countDocuments").resolves(7);
    const res = await PostsHelper.getProjectPhotoCount(PROJECT_ID);
    expect(res).to.equal(7);
    const q = stub.firstCall.args[0];
    expect(String(q.projectId)).to.equal(PROJECT_ID);
    expect(q.status).to.equal("ACTIVE");
  });

  it("Reports: excludes deleted using the LOWERCASE enum value", async function () {
    const stub = sinon.stub(ProjectReports, "countDocuments").resolves(2);
    await ProjectReportsHelpers.countByProject(PROJECT_ID);
    // Regression: REPORT_STATUS.DELETED is "deleted", not "DELETED".
    expect(stub.firstCall.args[0].status).to.deep.equal({ $ne: "deleted" });
  });

  it("Checklists: excludes templates (type=checklist) and deleted", async function () {
    const stub = sinon.stub(Checklist, "countDocuments").resolves(3);
    await ChecklistHelper.countByProject(PROJECT_ID);
    const q = stub.firstCall.args[0];
    expect(q.type).to.equal("checklist");
    expect(q.status).to.deep.equal({ $ne: "DELETED" });
  });

  it("Tasks: excludes deleted (PENDING + COMPLETED counted)", async function () {
    const stub = sinon.stub(ProjectTasks, "countDocuments").resolves(4);
    await ProjectTasksHelper.countByProject(PROJECT_ID);
    expect(stub.firstCall.args[0].status).to.deep.equal({ $ne: "DELETED" });
  });

  it("Notes: counts ACTIVE only", async function () {
    const stub = sinon.stub(ProjectNotes, "countDocuments").resolves(1);
    await ProjectNotesHelper.countByProject(PROJECT_ID);
    expect(stub.firstCall.args[0].status).to.equal("ACTIVE");
  });

  it("Files (STANDARD): scopes to own + PUBLIC — no restricted-file leak", async function () {
    const stub = sinon.stub(Files, "countDocuments").resolves(5);
    await FilesHelper.countByProject(
      COMPANY_ID,
      PROJECT_ID,
      USER_ID,
      "STANDARD",
    );
    const q = stub.firstCall.args[0];
    expect(q.status).to.deep.equal({ $ne: "DELETED" });
    expect(q.$or).to.be.an("array").with.lengthOf(2);
    expect(q.$or[0]).to.have.property("userId");
    expect(q.$or[1]).to.have.property("accessLevel", "public");
  });

  it("Files (ADMIN): no role $or filter — counts all project files", async function () {
    const stub = sinon.stub(Files, "countDocuments").resolves(9);
    await FilesHelper.countByProject(COMPANY_ID, PROJECT_ID, USER_ID, "ADMIN");
    expect(stub.firstCall.args[0].$or).to.equal(undefined);
  });
});

// The Tasks and Checklists list routes call countByProject with req.query's
// projectId straight through, on every path — including the global / checklistId
// / onlyMine ones that carry no projectId at all. ObjectId() THROWS on "" and a
// malformed id, and silently mints a RANDOM id on undefined, so an unguarded
// count turned list requests that used to return 200 into 500s and billed
// queries that could never match. Guard mirrors findAll's `return []`.
describe("Project tab-count guards (bad or missing projectId)", function () {
  afterEach(function () {
    sinon.restore();
  });

  it("Checklists: returns 0 without querying when no projectId is sent", async function () {
    const stub = sinon.stub(Checklist, "countDocuments").resolves(3);
    expect(await ChecklistHelper.countByProject(undefined)).to.equal(0);
    expect(stub.called).to.equal(false);
  });

  it("Checklists: returns 0 without querying on an empty projectId", async function () {
    const stub = sinon.stub(Checklist, "countDocuments").resolves(3);
    expect(await ChecklistHelper.countByProject("")).to.equal(0);
    expect(stub.called).to.equal(false);
  });

  it("Tasks: returns 0 without querying on a malformed projectId", async function () {
    const stub = sinon.stub(ProjectTasks, "countDocuments").resolves(4);
    expect(await ProjectTasksHelper.countByProject("abc")).to.equal(0);
    expect(stub.called).to.equal(false);
  });

  it("Tasks: returns 0 without querying when no projectId is sent", async function () {
    const stub = sinon.stub(ProjectTasks, "countDocuments").resolves(4);
    expect(await ProjectTasksHelper.countByProject(undefined)).to.equal(0);
    expect(stub.called).to.equal(false);
  });

  it("still counts normally for a valid projectId", async function () {
    sinon.stub(Checklist, "countDocuments").resolves(3);
    sinon.stub(ProjectTasks, "countDocuments").resolves(4);
    expect(await ChecklistHelper.countByProject(PROJECT_ID)).to.equal(3);
    expect(await ProjectTasksHelper.countByProject(PROJECT_ID)).to.equal(4);
  });
});

// GET /projects/search feeds the per-tab MATCH counts, while countByProject
// feeds the TOTALS they are rendered against ("N of M"). The two run different
// queries, so any filter present in one and missing from the other lets matched
// exceed total — the Checklists pill read "5 of 3" in production because this
// query counted deleted rows that the total excludes.
describe("Project search-result counts agree with the tab totals", function () {
  let ProjectRoutes;
  let stubs;

  before(function () {
    try {
      ProjectRoutes = require("../../lib/routes/projects/routes").ProjectRoutes;
    } catch (e) {
      this.skip();
    }
  });

  beforeEach(function () {
    stubs = {
      checklists: sinon.stub(ChecklistHelper, "findAllChecklist").resolves([]),
      uploads: sinon.stub(PostsHelper, "countUploadFiles").resolves(0),
      reports: sinon.stub(ProjectReportsHelpers, "getList").resolves([]),
      tasks: sinon.stub(ProjectTasksHelper, "findAll").resolves([]),
      files: sinon.stub(FilesHelper, "getFilesByProject").resolves([]),
    };
  });

  afterEach(function () {
    sinon.restore();
  });

  const mockRes = () => ({
    status: sinon.stub().returnsThis(),
    json: sinon.stub(),
  });

  const runSearch = async (searchText) => {
    const req = {
      query: { projectId: PROJECT_ID, postId: searchText },
      user: {
        _id: USER_ID,
        companyId: COMPANY_ID,
        companies: [{ companyId: COMPANY_ID, role: "ADMIN" }],
      },
    };
    await ProjectRoutes.getSearchResults(req, mockRes(), (e) => {
      throw e;
    });
    return stubs.checklists.firstCall.args[0];
  };

  it("REGRESSION: the checklist match excludes DELETED, like the total does", async function () {
    const query = await runSearch("e");
    expect(query.status).to.deep.equal({ $ne: "DELETED" });
  });

  // Raw, "a.c" matched "abc" here while the badge total (escaped, via the
  // checklist list route) matched only a literal "a.c" — matched > total, the
  // same "5 of 3" symptom as the missing DELETED filter. An unbalanced "(" is
  // rejected by Mongo outright, 500ing every tab's count in one shot.
  it("REGRESSION: escapes regex metacharacters in the checklist match", async function () {
    const query = await runSearch("a.c");
    expect(query.name.$regex).to.equal("a\\.c");
  });

  it("REGRESSION: an unbalanced paren survives as a literal", async function () {
    const query = await runSearch("(");
    expect(query.name.$regex).to.equal("\\(");
    // Sanity: the escaped output is a pattern Mongo will actually accept.
    expect(() => new RegExp(query.name.$regex)).to.not.throw();
  });

  it("caps the search pattern length", async function () {
    const query = await runSearch("x".repeat(500));
    expect(query.name.$regex).to.have.lengthOf(100);
  });

  // findAll backs both the Tasks tab and this endpoint's task count, so an
  // invalid pattern here 500s the tab bar as well as the list.
  it("REGRESSION: the task search escapes metacharacters too", async function () {
    stubs.tasks.restore();
    const agg = sinon.stub(ProjectTasks, "aggregate").resolves([]);
    await ProjectTasksHelper.findAll({ projectId: PROJECT_ID, search: "a.c" });
    const or = agg.firstCall.args[0][0].$match.$or;
    expect(or.map((c) => Object.values(c)[0].$regex)).to.deep.equal([
      "a\\.c",
      "a\\.c",
    ]);
  });

  it("pins the checklist match filter to countByProject's filter", async function () {
    const countStub = sinon.stub(Checklist, "countDocuments").resolves(3);
    await ChecklistHelper.countByProject(PROJECT_ID);
    const totalQuery = countStub.firstCall.args[0];
    const matchQuery = await runSearch("e");

    // Same type and status on both sides — otherwise matched can exceed total.
    expect(matchQuery.type).to.equal(totalQuery.type);
    expect(matchQuery.status).to.deep.equal(totalQuery.status);
    expect(String(matchQuery.projectId)).to.equal(String(totalQuery.projectId));
  });
});
