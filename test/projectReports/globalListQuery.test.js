const { expect } = require("chai");

describe("Global report list query helpers", function () {
  let escapeReportSearch;
  let normalizeReportListPaging;
  let buildGlobalReportMatch;
  let reportListPagination;

  before(function () {
    const mod = require("../../lib/routes/projectReport/listQuery");
    escapeReportSearch = mod.escapeReportSearch;
    normalizeReportListPaging = mod.normalizeReportListPaging;
    buildGlobalReportMatch = mod.buildGlobalReportMatch;
    reportListPagination = mod.reportListPagination;
  });

  describe("escapeReportSearch", function () {
    it("escapes regex metacharacters", function () {
      expect(escapeReportSearch("a.b*c(d)")).to.equal("a\\.b\\*c\\(d\\)");
    });

    it("leaves plain text unchanged", function () {
      expect(escapeReportSearch("Walkthrough 1")).to.equal("Walkthrough 1");
    });
  });

  describe("normalizeReportListPaging", function () {
    it("defaults to page 1, limit 20", function () {
      expect(normalizeReportListPaging({})).to.deep.equal({
        page: 1,
        limit: 20,
      });
    });

    it("parses provided values", function () {
      expect(
        normalizeReportListPaging({ page: "3", limit: "5" }),
      ).to.deep.equal({ page: 3, limit: 5 });
    });

    it("clamps page below 1 up to 1", function () {
      expect(normalizeReportListPaging({ page: "0" })).to.deep.equal({
        page: 1,
        limit: 20,
      });
    });

    it("falls back to defaults on non-numeric input", function () {
      expect(
        normalizeReportListPaging({ page: "abc", limit: "xyz" }),
      ).to.deep.equal({ page: 1, limit: 20 });
    });
  });

  describe("buildGlobalReportMatch", function () {
    it("scopes by projectId $in and excludes deleted reports", function () {
      const ids = ["aaa", "bbb"];
      const match = buildGlobalReportMatch(ids);
      expect(match.projectId).to.deep.equal({ $in: ids });
      expect(match.status).to.have.property("$ne");
      expect(match).to.not.have.property("reportName");
    });

    it("adds an escaped, case-insensitive name search when provided", function () {
      const match = buildGlobalReportMatch([], "a.b");
      expect(match.reportName).to.deep.equal({
        $regex: "a\\.b",
        $options: "i",
      });
    });
  });

  describe("reportListPagination", function () {
    it("computes totalPages with ceil", function () {
      expect(reportListPagination(21, 20)).to.deep.equal({
        total: 21,
        totalPages: 2,
      });
    });

    it("never returns fewer than 1 page (empty result)", function () {
      expect(reportListPagination(0, 20)).to.deep.equal({
        total: 0,
        totalPages: 1,
      });
    });
  });
});
