const { expect } = require("chai");
const sinon = require("sinon");
const mongoose = require("mongoose");

describe("Project list date range filtering", function () {
  let parseProjectListDateRange;
  let applyProjectCreatedAtDateRange;

  before(function () {
    parseProjectListDateRange =
      require("../../server/routes/projects/dateRange").parseProjectListDateRange;
    applyProjectCreatedAtDateRange =
      require("../../server/routes/projects/listQuery").applyProjectCreatedAtDateRange;
  });

  afterEach(function () {
    sinon.restore();
  });

  it("normalizes a single-day date range to full-day boundaries", function () {
    const result = parseProjectListDateRange(
      JSON.stringify({
        startDate: "2026-03-31T15:42:00.000Z",
      }),
    );

    expect(result.startDate).to.be.instanceOf(Date);
    expect(result.endDate).to.be.instanceOf(Date);
    expect(result.startDate.getUTCHours()).to.equal(0);
    expect(result.startDate.getUTCMinutes()).to.equal(0);
    expect(result.endDate.getUTCHours()).to.equal(23);
    expect(result.endDate.getUTCMinutes()).to.equal(59);
  });

  it("throws when startDate is missing", function () {
    expect(() =>
      parseProjectListDateRange(
        JSON.stringify({
          endDate: "2026-03-31T15:42:00.000Z",
        }),
      ),
    ).to.throw("dateRange.startDate is required");
  });

  it("adds a createdAt match to the project list query", function () {
    const startDate = new Date("2026-03-01T00:00:00.000Z");
    const endDate = new Date("2026-03-31T23:59:59.000Z");
    const query = {
      companyId: { $in: [new mongoose.Types.ObjectId()] },
      status: "ACTIVE",
      archivedAt: { $exists: false },
    };

    applyProjectCreatedAtDateRange(query, { startDate, endDate });

    expect(query.createdAt.$gte.getTime()).to.equal(startDate.getTime());
    expect(query.createdAt.$lte.getTime()).to.equal(endDate.getTime());
  });
});
