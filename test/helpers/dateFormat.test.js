const { expect } = require("chai");
const {
  formatDisplayDate,
  toIsoString,
  DISPLAY_DATE_FORMAT,
} = require("../../server/utils/helpers/dateFormat");

// Pure date-formatting helper shared by the API for "last updated" strings.
// Parses in UTC, so results are stable regardless of the machine's timezone.
// Runs against compiled output — no DB / env.
describe("dateFormat helpers", () => {
  describe("formatDisplayDate", () => {
    it("formats an ISO date-time string as MMM D, YYYY", () => {
      expect(formatDisplayDate("2026-09-22T13:45:00Z")).to.equal("Sep 22, 2026");
    });

    it("formats a bare date string as that UTC calendar day", () => {
      expect(formatDisplayDate("2026-01-05")).to.equal("Jan 5, 2026");
    });

    it("formats a Date instance", () => {
      expect(formatDisplayDate(new Date("2026-12-31T00:00:00Z"))).to.equal(
        "Dec 31, 2026",
      );
    });

    it("formats an epoch-ms number", () => {
      // 2026-09-22T13:45:00Z
      expect(formatDisplayDate(1790084700000)).to.equal("Sep 22, 2026");
    });

    it("is timezone-stable near a day boundary (parses as UTC)", () => {
      expect(formatDisplayDate("2026-03-01T00:30:00Z")).to.equal("Mar 1, 2026");
    });

    it("honours a caller-supplied format", () => {
      expect(formatDisplayDate("2026-09-22T13:45:00Z", "MM/DD/YYYY")).to.equal(
        "09/22/2026",
      );
    });

    it("defaults to the exported DISPLAY_DATE_FORMAT", () => {
      expect(DISPLAY_DATE_FORMAT).to.equal("MMM D, YYYY");
      expect(formatDisplayDate("2026-09-22T13:45:00Z")).to.equal(
        formatDisplayDate("2026-09-22T13:45:00Z", DISPLAY_DATE_FORMAT),
      );
    });

    it("returns an empty string for null, undefined and empty input", () => {
      expect(formatDisplayDate(null)).to.equal("");
      expect(formatDisplayDate(undefined)).to.equal("");
      expect(formatDisplayDate("")).to.equal("");
    });

    it("returns an empty string for an unparseable value", () => {
      expect(formatDisplayDate("not-a-date")).to.equal("");
      expect(formatDisplayDate(NaN)).to.equal("");
      expect(formatDisplayDate(new Date("nope"))).to.equal("");
    });
  });

  describe("toIsoString", () => {
    it("normalises a Date to a UTC ISO-8601 string", () => {
      expect(toIsoString(new Date("2026-09-22T13:45:00Z"))).to.equal(
        "2026-09-22T13:45:00.000Z",
      );
    });

    it("normalises an offset timestamp to UTC", () => {
      expect(toIsoString("2026-09-22T13:45:00+05:30")).to.equal(
        "2026-09-22T08:15:00.000Z",
      );
    });

    it("returns null for null, undefined and empty input", () => {
      expect(toIsoString(null)).to.equal(null);
      expect(toIsoString(undefined)).to.equal(null);
      expect(toIsoString("")).to.equal(null);
    });

    it("returns null for an unparseable value", () => {
      expect(toIsoString("not-a-date")).to.equal(null);
      expect(toIsoString(NaN)).to.equal(null);
    });
  });
});
