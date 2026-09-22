const { expect } = require("chai");
const sinon = require("sinon");
const mongoose = require("mongoose");
const { PostFiles, Posts, Project } = require("../../lib/db");
const { PostsHelper } = require("../../lib/routes/posts/helper");
const { ProjectHelper } = require("../../lib/routes/projects/helper");
const postCache = require("../../lib/services/redis/postCache");
const { SORT_TYPE } = require("../../lib/utils/enums/post");

// Run against an isolated local MongoDB, never the application's DB_PATH:
// TEST_UPLOADS_MONGO_URI=mongodb://127.0.0.1:27017 node_modules/.bin/mocha \
//   -r ts-node/register/transpile-only test/posts/gridProjectNames.test.js
const uri = process.env.TEST_UPLOADS_MONGO_URI;
const describeMongo = uri ? describe : describe.skip;

describeMongo("Grid project names (local MongoDB)", function () {
  this.timeout(15000);
  const id = () => new mongoose.Types.ObjectId();
  let companyId, otherCompanyId, userId, projectA, projectB, missingProject;
  let rows, actor, projectFind;
  let ownsConnection = false;

  before(async function () {
    const url = new URL(uri);
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("Grid project tests require an isolated local MongoDB");
    }
    if (mongoose.connection.readyState !== 0) {
      throw new Error("Grid project tests require a fresh MongoDB connection");
    }
    await mongoose.connect(uri, {
      dbName: `test_grid_projects_${id()}`,
      autoIndex: false,
    });
    ownsConnection = true;
  });

  after(async function () {
    if (ownsConnection && mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async function () {
    await Promise.all([
      PostFiles.deleteMany({}),
      Posts.deleteMany({}),
      Project.deleteMany({}),
    ]);
    companyId = id();
    otherCompanyId = id();
    userId = id();
    projectA = id();
    projectB = id();
    missingProject = id();
    const blankProject = id();
    const foreignProject = id();
    actor = { userId, role: "ADMIN", companyIds: [companyId] };
    await Project.collection.insertMany([
      { _id: projectA, companyId, name: "  Christensen House  " },
      { _id: projectB, companyId, name: "Second Project" },
      { _id: blankProject, companyId, name: "  " },
      {
        _id: foreignProject,
        companyId: otherCompanyId,
        name: "Private Project",
      },
    ]);

    rows = [];
    const postDocs = [];
    const makePost = (projectId, day, positions, scope = companyId) => {
      const postId = id();
      const createdAt = new Date(Date.UTC(2026, 0, day));
      postDocs.push({
        _id: postId,
        projectId,
        companyId: scope,
        userId,
        createdAt,
        totalFiles: positions.length,
        note: "Post note",
        status: "ACTIVE",
      });
      positions.forEach((position, index) =>
        rows.push({
          _id: id(),
          postId,
          projectId,
          companyId: scope,
          userId,
          position,
          status: "ACTIVE",
          fileType: "image",
          url: `https://example.test/${postId}/${position}.jpg`,
          createdAt,
          postSortDate: createdAt,
          timestamp: new Date(createdAt.getTime() + index * 60000),
          commentCount: 0,
        }),
      );
    };
    makePost(projectA, 10, [0, 3, 7]);
    makePost(projectB, 11, [0]);
    makePost(blankProject, 12, [0]);
    makePost(missingProject, 13, [0]);
    // A malformed cross-company reference must not expose the project's name.
    makePost(foreignProject, 14, [0]);
    makePost(foreignProject, 15, [0], otherCompanyId);
    await Posts.collection.insertMany(postDocs);
    await PostFiles.collection.insertMany(rows);

    // Count caching is unrelated to captions; use actual Mongo counts each time.
    sinon
      .stub(postCache, "getCachedUploadsTotal")
      .callsFake((company, match, compute) => compute());
    projectFind = sinon.spy(Project, "find");
  });

  afterEach(function () {
    sinon.restore();
  });

  const query = (sortBy, extra = {}) => ({
    page: 1,
    skips: 0,
    pageSize: 40,
    sortBy,
    ...extra,
  });
  const ids = (items) => items.map((item) => String(item.files._id));
  const names = (items) =>
    items.map((item) => item.projectName).filter(Boolean);
  const sorts = [
    SORT_TYPE.NEWEST,
    SORT_TYPE.OLDEST,
    SORT_TYPE.DATE_TAKEN_ASC,
    SORT_TYPE.DATE_TAKEN_DESC,
  ];

  for (const method of ["getGridPosts", "getGridPostsV2"]) {
    for (const sort of sorts) {
      it(`${method}/${sort}: keeps order, ranks and totals while adding scoped names`, async function () {
        const [page] = await PostsHelper[method](query(sort), actor);
        const ascending = [SORT_TYPE.OLDEST, SORT_TYPE.DATE_TAKEN_ASC].includes(
          sort,
        );
        const byTimestamp =
          sort === SORT_TYPE.DATE_TAKEN_ASC ||
          sort === SORT_TYPE.DATE_TAKEN_DESC;
        const expected = rows
          .filter((row) => row.companyId.equals(companyId))
          .sort((a, b) => {
            const diff = byTimestamp
              ? a.timestamp - b.timestamp
              : a.createdAt - b.createdAt;
            return (ascending ? diff : -diff) || a.position - b.position;
          });
        expect(ids(page.items)).to.deep.equal(
          expected.map((row) => String(row._id)),
        );
        expect(page.total).to.equal(7);
        expect(page.totalFiles).to.equal(7);
        expect(page.totalPages).to.equal(1);
        expect(page.items.every((item) => item.projectId)).to.equal(true);
        expect(names(page.items).sort()).to.deep.equal([
          "Christensen House",
          "Christensen House",
          "Christensen House",
          "Second Project",
        ]);
        const projectRows = page.items.filter((row) =>
          row.projectId.equals(projectA),
        );
        expect(projectRows.map((row) => row.fileIndex).sort()).to.deep.equal([
          0, 1, 2,
        ]);
        expect(
          page.items
            .filter((row) => !row.projectName)
            .every((row) => !Object.hasOwn(row, "projectName")),
        ).to.equal(true);
        expect(projectFind.callCount).to.equal(1);
        const [match, projection] = projectFind.firstCall.args;
        expect(String(match.companyId)).to.equal(String(companyId));
        expect(match._id.$in).to.have.length(5);
        expect(projection).to.deep.equal({ _id: 1, name: 1 });
      });
    }
  }

  for (const sort of sorts) {
    it(`${sort}: enriches only the final page, preserving filters and file ranks`, async function () {
      const [page] = await PostsHelper.getGridPostsV2(
        query(sort, {
          page: 2,
          skips: 1,
          pageSize: 1,
          filterProjects: JSON.stringify([projectA]),
        }),
        actor,
      );
      expect(page.items).to.have.length(1);
      expect(page.items[0].files._id.equals(rows[1]._id)).to.equal(true);
      expect(page.items[0].fileIndex).to.equal(1);
      expect(page.items[0].projectName).to.equal("Christensen House");
      expect(page.totalFiles).to.equal(3);
      expect(page.totalPages).to.equal(3);
      expect(projectFind.callCount).to.equal(1);
      expect(projectFind.firstCall.args[0]._id.$in.map(String)).to.deep.equal([
        String(projectA),
      ]);
    });

    it(`${sort}: skips project lookup for empty pages`, async function () {
      const [page] = await PostsHelper.getGridPostsV2(
        query(sort, { skips: 100 }),
        actor,
      );
      expect(page.items).to.deep.equal([]);
      expect(projectFind.called).to.equal(false);
    });

    it(`${sort}: retains member visibility`, async function () {
      const scope = sinon
        .stub(ProjectHelper, "getMineAndCompanyProjects")
        .resolves({ projectIds: [projectA] });
      const [page] = await PostsHelper.getGridPostsV2(query(sort), {
        ...actor,
        role: "STANDARD",
      });
      expect(scope.calledOnce).to.equal(true);
      expect(page.items).to.have.length(3);
      expect(
        page.items.every((row) => row.projectId.equals(projectA)),
      ).to.equal(true);
      expect(projectFind.firstCall.args[0]._id.$in.map(String)).to.deep.equal([
        String(projectA),
      ]);
    });
  }

  it("reads renamed projects on the next fetch", async function () {
    await PostsHelper.getGridPostsV2(query(SORT_TYPE.NEWEST), actor);
    await Project.updateOne(
      { _id: projectA },
      { $set: { name: "Renamed House" } },
    );
    const [page] = await PostsHelper.getGridPostsV2(
      query(SORT_TYPE.NEWEST),
      actor,
    );
    expect(names(page.items))
      .to.include("Renamed House")
      .and.not.include("Christensen House");
    expect(projectFind.callCount).to.equal(2);
  });

  it("uses the resolved project's company for a shared-project request", async function () {
    const [page] = await PostsHelper.getGridPostsV2(
      query(SORT_TYPE.NEWEST, { projectId: String(projectA) }),
    );
    expect(page.items).to.have.length(3);
    expect(names(page.items)).to.deep.equal(Array(3).fill("Christensen House"));
    expect(String(projectFind.firstCall.args[0].companyId)).to.equal(
      String(companyId),
    );
  });
});
