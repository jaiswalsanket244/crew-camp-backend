const { expect } = require("chai");
const { Types } = require("mongoose");

// Run with: NODE_ENV=test npx mocha -r ts-node/register test/aiProjectUpdate
describe("AI Project Update list query helpers", function () {
  let q;

  before(function () {
    q = require("../../server/routes/aiProjectUpdate/listQuery");
  });

  describe("escapeUpdateSearch", function () {
    it("escapes regex metacharacters and caps length", function () {
      expect(q.escapeUpdateSearch("a.b*c(d)")).to.equal("a\\.b\\*c\\(d\\)");
      expect(q.escapeUpdateSearch("x".repeat(500))).to.have.length(100);
    });
  });

  describe("normalizeUpdateListPaging", function () {
    it("defaults to page 1, limit 20", function () {
      expect(q.normalizeUpdateListPaging({})).to.deep.equal({
        page: 1,
        limit: 20,
      });
    });
    it("parses values and clamps limit to 1..50, page to >= 1", function () {
      expect(
        q.normalizeUpdateListPaging({ page: "3", limit: "5" }),
      ).to.deep.equal({ page: 3, limit: 5 });
      expect(q.normalizeUpdateListPaging({ limit: "500" })).to.deep.equal({
        page: 1,
        limit: 50,
      });
      expect(
        q.normalizeUpdateListPaging({ page: "0", limit: "0" }),
      ).to.deep.equal({ page: 1, limit: 20 });
      expect(q.normalizeUpdateListPaging({ limit: "-5" })).to.deep.equal({
        page: 1,
        limit: 1,
      });
      expect(
        q.normalizeUpdateListPaging({ page: "abc", limit: "xyz" }),
      ).to.deep.equal({ page: 1, limit: 20 });
    });
  });

  describe("buildUpdateListMatch", function () {
    const projectId = new Types.ObjectId();
    const companyId = new Types.ObjectId();

    it("scopes by project AND company and excludes deleted", function () {
      const match = q.buildUpdateListMatch(projectId, companyId);
      expect(match.projectId).to.equal(projectId);
      expect(match.companyId).to.equal(companyId);
      expect(match.status).to.deep.equal({ $ne: "deleted" });
      expect(match).to.not.have.property("title");
    });

    it("adds an escaped, case-insensitive title regex for search", function () {
      const match = q.buildUpdateListMatch(projectId, companyId, " Bath (1) ");
      expect(match.title).to.deep.equal({
        $regex: "Bath \\(1\\)",
        $options: "i",
      });
    });

    it("ignores blank search", function () {
      expect(
        q.buildUpdateListMatch(projectId, companyId, "   "),
      ).to.not.have.property("title");
    });
  });

  describe("updateListPagination", function () {
    it("never reports fewer than 1 page", function () {
      expect(q.updateListPagination(0, 20)).to.deep.equal({
        total: 0,
        totalPages: 1,
      });
      expect(q.updateListPagination(41, 20)).to.deep.equal({
        total: 41,
        totalPages: 3,
      });
    });
  });
});
