const sinon = require("sinon");
const { expect } = require("chai");

// Personal View — cross-project "my {tasks,checklists,reports}" endpoints.
// Tests target the COMPILED output (../server), matching the `server-test`
// script (tsc → mocha). Helper-level tests stub Model.aggregate and assert the
// pipeline that gets built — deterministic, no Mongo. Route-level tests import
// heavier modules and self-skip if those modules can't load in this env.

const { ProjectTasks, Checklist, ProjectReports } = require("../server/db");
const { ProjectTasksHelper } = require("../server/routes/projectTasks/helper");
const { ChecklistHelper } = require("../server/routes/checklist/helper");
const {
  ProjectReportsHelpers,
} = require("../server/routes/projectReport/helpers");
const { ObjectId } = require("../server/utils/helpers/commonHelper");

// Valid 24-char hex — ObjectId() throws on anything else.
const USER_ID = "507f1f77bcf86cd799439011";
const PROJECT_A = "507f1f77bcf86cd799439021";
const PROJECT_B = "507f1f77bcf86cd799439022";
const COMPANY_ID = "507f1f77bcf86cd799439031";

// Pull the $and clauses out of a findMine pipeline.
function taskMatchAnd(aggStub) {
  return aggStub.firstCall.args[0][0].$match.$and;
}
// Stages are located by shape, not index, so adding a stage can't silently
// repoint these at the wrong one.
function taskStage(aggStub, key) {
  return aggStub.firstCall.args[0].find((s) => s[key])[key];
}
// Find a stage inside the $facet data branch.
function taskFacetStage(aggStub, key) {
  return taskStage(aggStub, "$facet").data.find((s) => s[key])[key];
}
function findClause(and, key) {
  return and.find((c) => Object.prototype.hasOwnProperty.call(c, key));
}

describe("ProjectTasksHelper.findMine — match construction", function () {
  let aggStub;
  beforeEach(function () {
    aggStub = sinon
      .stub(ProjectTasks, "aggregate")
      .resolves([{ data: [], metadata: [{ total: 7 }] }]);
  });
  afterEach(() => sinon.restore());

  const base = {
    userId: ObjectId(USER_ID),
    projectIds: [ObjectId(PROJECT_A), ObjectId(PROJECT_B)],
    page: 1,
    pageSize: 20,
  };

  it("scopes to member projects via projectId $in (authorization boundary)", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "assigned" });
    const inClause = findClause(taskMatchAnd(aggStub), "projectId");
    expect(inClause.projectId.$in).to.have.length(2);
  });

  it("returns empty without querying Mongo when the user is in no projects", async function () {
    const res = await ProjectTasksHelper.findMine({
      ...base,
      projectIds: [],
      filter: "assigned",
    });
    expect(aggStub.called).to.equal(false);
    expect(res.data).to.deep.equal([]);
    expect(res.pagination.totalCount).to.equal(0);
    expect(res.pagination.totalPages).to.equal(0);
  });

  it("filter=assigned matches assignedTo.userId (default behavior)", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "assigned" });
    const and = taskMatchAnd(aggStub);
    const assigned = findClause(and, "assignedTo.userId");
    expect(assigned["assignedTo.userId"].toString()).to.equal(USER_ID);
    expect(findClause(and, "userId")).to.equal(undefined);
  });

  it("filter=created matches userId only", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "created" });
    const and = taskMatchAnd(aggStub);
    expect(findClause(and, "userId").userId.toString()).to.equal(USER_ID);
    expect(findClause(and, "assignedTo.userId")).to.equal(undefined);
  });

  it("filter=all is the $or of created and assigned", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "all" });
    const orClause = findClause(taskMatchAnd(aggStub), "$or");
    expect(orClause.$or).to.have.length(2);
    const keys = orClause.$or.map((c) => Object.keys(c)[0]);
    expect(keys).to.have.members(["userId", "assignedTo.userId"]);
  });

  it("excludes DELETED by default, but an explicit status overrides", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "assigned" });
    let status = findClause(taskMatchAnd(aggStub), "status").status;
    expect(status).to.deep.equal({ $ne: "DELETED" });

    sinon.restore();
    aggStub = sinon
      .stub(ProjectTasks, "aggregate")
      .resolves([{ data: [], metadata: [] }]);
    await ProjectTasksHelper.findMine({
      ...base,
      filter: "assigned",
      status: "COMPLETED",
    });
    status = findClause(taskMatchAnd(aggStub), "status").status;
    expect(status).to.equal("COMPLETED");
  });

  it("search adds a name/description $or without colliding with the filter $or", async function () {
    await ProjectTasksHelper.findMine({
      ...base,
      filter: "all",
      search: "leak",
    });
    // Two separate $and entries both keyed $or: one ownership, one search.
    const ors = taskMatchAnd(aggStub).filter((c) => c.$or);
    expect(ors).to.have.length(2);
    const searchOr = ors.find((o) => o.$or.some((c) => c.name));
    expect(searchOr.$or.map((c) => Object.keys(c)[0])).to.have.members([
      "name",
      "description",
    ]);
  });

  it("projects isProjectArchived so archived rows render read-only (D12.4)", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "assigned" });
    expect(taskFacetStage(aggStub, "$project")).to.have.property(
      "isProjectArchived",
    );
  });

  it("sorts with an _id tiebreaker so pages can't repeat or skip a row", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "assigned" });
    expect(taskFacetStage(aggStub, "$sort")).to.deep.equal({
      createdAt: -1,
      _id: -1,
    });
  });

  it("keeps the sort inside the data branch and above $skip/$limit so it stays bounded", async function () {
    await ProjectTasksHelper.findMine({ ...base, filter: "assigned" });
    const stages = aggStub.firstCall.args[0];
    // A $sort above the $facet gets no limit pushed into it and blocks on the
    // full match set; no index serves { createdAt, _id } here.
    expect(stages.some((s) => s.$sort)).to.equal(false);
    const data = taskStage(aggStub, "$facet").data;
    expect(data.findIndex((s) => s.$sort)).to.be.lessThan(
      data.findIndex((s) => s.$skip),
    );
  });

  it("derives $skip from page/pageSize and enriches only the current page", async function () {
    await ProjectTasksHelper.findMine({ ...base, page: 3, filter: "assigned" });
    const data = taskStage(aggStub, "$facet").data;
    expect(taskFacetStage(aggStub, "$skip")).to.equal(40);
    expect(taskFacetStage(aggStub, "$limit")).to.equal(20);
    // $lookups must come after $skip/$limit so they only touch the page's rows.
    expect(data.findIndex((s) => s.$limit)).to.be.lessThan(
      data.findIndex((s) => s.$lookup),
    );
  });

  it("returns { data, pagination } from the facet result", async function () {
    const res = await ProjectTasksHelper.findMine({
      ...base,
      filter: "assigned",
    });
    expect(res).to.deep.equal({
      data: [],
      pagination: { page: 1, pageSize: 20, totalCount: 7, totalPages: 1 },
    });
  });

  it("escapes regex metacharacters in search (no ReDoS / injection)", async function () {
    await ProjectTasksHelper.findMine({
      ...base,
      filter: "assigned",
      search: "a+b(c)",
    });
    const searchOr = taskMatchAnd(aggStub).find(
      (c) => c.$or && c.$or.some((x) => x.name),
    );
    expect(searchOr.$or[0].name.$regex).to.equal("a\\+b\\(c\\)");
  });
});

describe("ChecklistHelper.findAllChecklist — onlyMine field gating", function () {
  let aggStub;
  beforeEach(function () {
    aggStub = sinon.stub(Checklist, "aggregate").resolves([]);
  });
  afterEach(() => sinon.restore());

  function projectStage() {
    return aggStub.firstCall.args[0].find((s) => s.$project).$project;
  }

  it("CRITICAL REGRESSION: default projection is unchanged — same fields AND same value expressions (no isProjectArchived)", async function () {
    await ChecklistHelper.findAllChecklist({ companyId: COMPANY_ID });
    const stage = projectStage();
    expect(stage).to.not.have.property("isProjectArchived");
    expect(Object.keys(stage)).to.have.members([
      "name",
      "userName",
      "contributors",
      "todoList",
      "totalTodo",
      "completedTodo",
      // V2 progress counters — every non-onlyMine caller depends on these, so
      // they must survive the projectStage hoist that gates isProjectArchived.
      "totalFields",
      "completedFields",
      "createdAt",
      "projectId",
      "projectName",
    ]);
    // Pin the VALUE expressions too — a field-set check alone wouldn't catch a
    // silent mutation of a sub-expression (review finding #7).
    expect(stage.name).to.equal(1);
    expect(stage.userName).to.equal(1);
    expect(stage.createdAt).to.equal(1);
    expect(stage.projectId).to.equal(1);
    expect(stage.projectName).to.equal(1);
    expect(stage.totalTodo).to.deep.equal({ $size: "$todoList" });
    expect(stage.todoList).to.deep.equal({
      $sortArray: { input: "$todoList", sortBy: { sortOrder: 1 } },
    });
    expect(stage.completedTodo).to.deep.equal({
      $size: {
        $filter: {
          input: "$todoList",
          as: "todo",
          cond: { $eq: ["$$todo.status", "COMPLETED"] },
        },
      },
    });
    // The V2 counters are large $reduce expressions; pin their shape (a fold
    // over todoList) rather than the whole tree, which would be brittle.
    expect(stage.totalFields.$reduce.input).to.equal("$todoList");
    expect(stage.totalFields.$reduce.initialValue).to.equal(0);
    expect(stage.completedFields.$reduce.input).to.equal("$todoList");
    expect(stage.completedFields.$reduce.initialValue).to.equal(0);
  });

  it("adds isProjectArchived only when includeProjectArchived is set", async function () {
    await ChecklistHelper.findAllChecklist(
      { companyId: COMPANY_ID },
      undefined,
      {
        includeProjectArchived: true,
      },
    );
    expect(projectStage()).to.have.property("isProjectArchived");
  });

  it("limits BEFORE the lookups so hydration only touches returned rows", async function () {
    await ChecklistHelper.findAllChecklist({ companyId: COMPANY_ID }, 50);
    const stages = aggStub.firstCall.args[0];
    const limitAt = stages.findIndex((s) => s.$limit);
    const firstLookupAt = stages.findIndex((s) => s.$lookup);
    expect(limitAt).to.be.greaterThan(-1);
    // With $limit last, a company-wide $match hydrated every matching
    // checklist's todos + images and then discarded all but `limit`.
    expect(limitAt).to.be.lessThan(firstLookupAt);
    expect(stages.findIndex((s) => s.$sort)).to.be.lessThan(limitAt);
  });

  it("sorts newest-first with an _id tiebreaker for a deterministic slice", async function () {
    await ChecklistHelper.findAllChecklist({ companyId: COMPANY_ID }, 50);
    const sort = aggStub.firstCall.args[0].find((s) => s.$sort).$sort;
    expect(sort).to.deep.equal({ createdAt: -1, _id: -1 });
  });

  it("omits $limit entirely when no limit is supplied", async function () {
    await ChecklistHelper.findAllChecklist({ companyId: COMPANY_ID });
    expect(aggStub.firstCall.args[0].some((s) => s.$limit)).to.equal(false);
  });
});

describe("ProjectReportsHelpers.getMyReports — query construction", function () {
  let aggStub;
  beforeEach(function () {
    aggStub = sinon.stub(ProjectReports, "aggregate").resolves([]);
  });
  afterEach(() => sinon.restore());

  function pipeline() {
    return aggStub.firstCall.args[0];
  }

  it("matches my userId, scopes to current company, and excludes deleted reports", async function () {
    await ProjectReportsHelpers.getMyReports({
      userId: USER_ID,
      companyId: COMPANY_ID,
    });
    const match = pipeline()[0].$match;
    expect(match.userId.toString()).to.equal(USER_ID);
    expect(match.companyId.toString()).to.equal(COMPANY_ID);
    expect(match.status).to.deep.equal({ $ne: "deleted" });
  });

  it("joins projects and projects projectName + isProjectArchived (survives deleted project)", async function () {
    await ProjectReportsHelpers.getMyReports({
      userId: USER_ID,
      companyId: COMPANY_ID,
    });
    const p = pipeline();
    const lookup = p.find((s) => s.$lookup);
    expect(lookup.$lookup.from).to.equal("projects");
    const project = p.find((s) => s.$project).$project;
    expect(project).to.have.property("projectName");
    expect(project).to.have.property("isProjectArchived");
  });

  it("escapes regex metacharacters in search (no ReDoS / injection)", async function () {
    await ProjectReportsHelpers.getMyReports({
      userId: USER_ID,
      companyId: COMPANY_ID,
      search: "a+b(c)",
    });
    // Metacharacters are backslash-escaped → matched literally.
    expect(pipeline()[0].$match.reportName).to.deep.equal({
      $regex: "a\\+b\\(c\\)",
      $options: "i",
    });
  });
});

// ---- Route-level (heavier imports; self-skip if the module can't load) ----

describe("GET /checklist — onlyMine route logic", function () {
  let ChecklistRoutes, Helper, ProjectHelper, findAllStub, myProjStub;
  before(function () {
    try {
      ChecklistRoutes =
        require("../server/routes/checklist/routes").ChecklistRoutes;
      Helper = require("../server/routes/checklist/helper").ChecklistHelper;
      ProjectHelper = require("../server/routes/projects/helper").ProjectHelper;
    } catch (e) {
      this.skip();
    }
  });
  beforeEach(function () {
    findAllStub = sinon.stub(Helper, "findAllChecklist").resolves([]);
    myProjStub = sinon.stub(ProjectHelper, "getMyProjectsArray").resolves([]);
  });
  afterEach(() => sinon.restore());

  const mockRes = () => ({
    status: sinon.stub().returnsThis(),
    json: sinon.stub(),
  });

  it("onlyMine=true builds $or [userId, contributors] and requests the archived flag", async function () {
    const req = {
      query: { onlyMine: "true", type: "checklist" },
      user: { _id: USER_ID, companyId: COMPANY_ID },
    };
    await ChecklistRoutes.getChecklists(req, mockRes(), () => {});
    expect(findAllStub.calledOnce).to.equal(true);
    const payload = findAllStub.firstCall.args[0];
    expect(payload.$or).to.be.an("array").with.length(2);
    expect(payload.$or.map((c) => Object.keys(c)[0])).to.have.members([
      "userId",
      "contributors",
    ]);
    expect(findAllStub.firstCall.args[2]).to.deep.equal({
      includeProjectArchived: true,
    });
  });

  it("onlyMine=true without an authenticated user returns 401", async function () {
    const res = mockRes();
    const req = {
      query: { onlyMine: "true", type: "checklist" },
      user: undefined,
    };
    await ChecklistRoutes.getChecklists(req, res, () => {});
    expect(res.status.calledWith(401)).to.equal(true);
    expect(findAllStub.called).to.equal(false);
  });

  it("REGRESSION: without onlyMine, no $or is added and the archived flag stays off", async function () {
    const req = {
      query: { type: "checklist" },
      user: { _id: USER_ID, companyId: COMPANY_ID },
    };
    await ChecklistRoutes.getChecklists(req, mockRes(), () => {});
    const payload = findAllStub.firstCall.args[0];
    expect(payload.$or).to.equal(undefined);
    expect(findAllStub.firstCall.args[2]).to.deep.equal({
      includeProjectArchived: false,
    });
  });

  it("defaults a server-side limit (50) on onlyMine when the client omits it", async function () {
    const req = {
      query: { onlyMine: "true", type: "checklist" },
      user: { _id: USER_ID, companyId: COMPANY_ID },
    };
    await ChecklistRoutes.getChecklists(req, mockRes(), () => {});
    // findAllChecklist(payload, limitValue, options) — limitValue is arg[1].
    expect(findAllStub.firstCall.args[1]).to.equal(50);
  });
});

describe("GET /projectReports/mine — route", function () {
  let ProjectReportsRoutes, Helper, getMineStub;
  before(function () {
    try {
      ProjectReportsRoutes =
        require("../server/routes/projectReport/routes").ProjectReportsRoutes;
      Helper =
        require("../server/routes/projectReport/helpers").ProjectReportsHelpers;
    } catch (e) {
      this.skip();
    }
  });
  beforeEach(function () {
    getMineStub = sinon.stub(Helper, "getMyReports").resolves([]);
  });
  afterEach(() => sinon.restore());

  const mockRes = () => ({
    status: sinon.stub().returnsThis(),
    json: sinon.stub(),
  });

  async function callRoute(query) {
    await ProjectReportsRoutes.getMyReports(
      { query, user: { _id: USER_ID, companyId: COMPANY_ID } },
      mockRes(),
      () => {},
    );
    return getMineStub.firstCall.args[0];
  }

  it("defaults the limit when the client omits one (never unbounded)", async function () {
    expect((await callRoute({})).limit).to.equal(100);
  });

  it("caps an oversized limit", async function () {
    expect((await callRoute({ limit: "99999" })).limit).to.equal(200);
  });

  it("falls back to the default on a non-positive or junk limit", async function () {
    expect((await callRoute({ limit: "-5" })).limit).to.equal(100);
    sinon.resetHistory?.();
    getMineStub.resetHistory();
    expect((await callRoute({ limit: "abc" })).limit).to.equal(100);
  });

  it("honours a client limit within bounds", async function () {
    expect((await callRoute({ limit: "25" })).limit).to.equal(25);
  });

  it("scopes to the caller's company", async function () {
    expect((await callRoute({})).companyId).to.equal(COMPANY_ID);
  });
});

describe("GET /projectTasks/mine — route", function () {
  let ProjectTaskRoutes, Helper, ProjectHelper, findMineStub;
  before(function () {
    try {
      ProjectTaskRoutes =
        require("../server/routes/projectTasks/routes").ProjectTaskRoutes;
      Helper =
        require("../server/routes/projectTasks/helper").ProjectTasksHelper;
      ProjectHelper = require("../server/routes/projects/helper").ProjectHelper;
    } catch (e) {
      this.skip();
    }
  });
  afterEach(() => sinon.restore());

  const mockRes = () => ({
    status: sinon.stub().returnsThis(),
    json: sinon.stub(),
  });

  const emptyPage = {
    data: [],
    pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0 },
  };

  // Scope comes from getMyProjects (ObjectIds), not getMyProjectsArray
  // (strings) — findMine feeds projectIds straight into $in with no cast.
  function stubScope(projectIds, page = emptyPage) {
    sinon.stub(ProjectHelper, "getMyProjects").resolves(projectIds);
    findMineStub = sinon.stub(Helper, "findMine").resolves(page);
  }

  async function callRoute(query) {
    const res = mockRes();
    await ProjectTaskRoutes.getMyTasks(
      { query, user: { _id: ObjectId(USER_ID) } },
      res,
      () => {},
    );
    return res;
  }

  it("passes the member-project scope through and relays an empty envelope", async function () {
    stubScope([]);
    const res = await callRoute({});
    expect(findMineStub.firstCall.args[0].projectIds).to.deep.equal([]);
    const body = res.json.firstCall.args[0];
    expect(body.data.data).to.deep.equal([]);
    expect(body.data.pagination.totalCount).to.equal(0);
  });

  it("defaults filter to 'assigned' when none is supplied", async function () {
    stubScope([ObjectId(PROJECT_A)]);
    await callRoute({});
    expect(findMineStub.firstCall.args[0].filter).to.equal("assigned");
  });

  it("clamps a negative page to 1 so $skip is never negative (would 500 in Mongo)", async function () {
    stubScope([ObjectId(PROJECT_A)]);
    await callRoute({ page: "-5" });
    expect(findMineStub.firstCall.args[0].page).to.equal(1);
  });

  it("clamps an oversized pageSize to the 100 ceiling (resource-exhaustion guard)", async function () {
    stubScope([ObjectId(PROJECT_A)]);
    await callRoute({ pageSize: "9999999" });
    expect(findMineStub.firstCall.args[0].pageSize).to.equal(100);
  });

  it("defaults pageSize to 20 when the client omits it", async function () {
    stubScope([ObjectId(PROJECT_A)]);
    await callRoute({});
    expect(findMineStub.firstCall.args[0].pageSize).to.equal(20);
  });
});
