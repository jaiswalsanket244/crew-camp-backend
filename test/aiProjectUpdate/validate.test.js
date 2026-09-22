const { expect } = require("chai");

// Pure validation for the AI Project Update routes — no Mongo, no OpenAI.
// Run with: NODE_ENV=test npx mocha -r ts-node/register test/aiProjectUpdate
describe("AI Project Update validation helpers", function () {
  let v;

  const ID_A = "64b000000000000000000001";
  const ID_B = "64b000000000000000000002";

  before(function () {
    v = require("../../server/routes/aiProjectUpdate/validate");
  });

  describe("isIsoDay", function () {
    it("accepts a real calendar day", function () {
      expect(v.isIsoDay("2026-08-18")).to.equal(true);
    });
    it("rejects wrong shape, impossible days and non-strings", function () {
      expect(v.isIsoDay("2026-8-18")).to.equal(false);
      expect(v.isIsoDay("2026-02-30")).to.equal(false);
      expect(v.isIsoDay("2026-08-18T00:00:00Z")).to.equal(false);
      expect(v.isIsoDay(20260818)).to.equal(false);
    });
  });

  describe("isValidTimeZone", function () {
    it("accepts IANA zones and UTC", function () {
      expect(v.isValidTimeZone("America/Denver")).to.equal(true);
      expect(v.isValidTimeZone("UTC")).to.equal(true);
    });
    it("rejects garbage and empty", function () {
      expect(v.isValidTimeZone("Mars/Olympus")).to.equal(false);
      expect(v.isValidTimeZone("")).to.equal(false);
      expect(v.isValidTimeZone(undefined)).to.equal(false);
    });
  });

  describe("validateDateRange", function () {
    it("accepts start <= end, including a single day", function () {
      expect(v.validateDateRange("2026-08-18", "2026-09-05")).to.equal(null);
      expect(v.validateDateRange("2026-09-05", "2026-09-05")).to.equal(null);
    });
    it("rejects start after end and bad shapes", function () {
      expect(v.validateDateRange("2026-09-06", "2026-09-05")).to.be.a("string");
      expect(v.validateDateRange("bad", "2026-09-05")).to.be.a("string");
      expect(v.validateDateRange("2026-09-05", null)).to.be.a("string");
    });
  });

  describe("validateTitle", function () {
    it("requires non-blank text within 120 chars", function () {
      expect(v.validateTitle("Kitchen & Bath Finishes Underway")).to.equal(
        null,
      );
      expect(v.validateTitle("   ")).to.be.a("string");
      expect(v.validateTitle(undefined)).to.be.a("string");
      expect(v.validateTitle("x".repeat(121))).to.be.a("string");
      expect(v.validateTitle("x".repeat(120))).to.equal(null);
    });
  });

  describe("validateFileIds", function () {
    it("accepts 1..50 unique ObjectId strings", function () {
      expect(v.validateFileIds([ID_A, ID_B])).to.deep.equal({
        ids: [ID_A, ID_B],
        error: null,
      });
      const fifty = Array.from(
        { length: 50 },
        (_, i) => `64b0000000000000000000${String(i).padStart(2, "0")}`,
      );
      expect(v.validateFileIds(fifty).error).to.equal(null);
    });
    it("rejects empty, over 50, non-ObjectId and duplicates — never truncates", function () {
      expect(v.validateFileIds([]).error).to.be.a("string");
      const fiftyOne = Array.from(
        { length: 51 },
        (_, i) => `64b0000000000000000000${String(i).padStart(2, "0")}`,
      );
      const over = v.validateFileIds(fiftyOne);
      expect(over.ids).to.equal(null);
      expect(over.error).to.match(/at most 50/);
      expect(v.validateFileIds([ID_A, "not-an-id"]).error).to.be.a("string");
      expect(v.validateFileIds([ID_A, ID_A]).error).to.match(/Duplicate/);
      expect(v.validateFileIds("nope").error).to.be.a("string");
    });
  });

  describe("validateRichTextDoc", function () {
    const para = (text, marks) => ({
      type: "paragraph",
      content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
    });

    it("accepts null and the editor's own node set", function () {
      expect(v.validateRichTextDoc(null)).to.equal(null);
      expect(v.validateRichTextDoc(undefined)).to.equal(null);
      const doc = {
        type: "doc",
        content: [
          para("Cabinets set.", [{ type: "bold" }, { type: "italic" }]),
          {
            type: "orderedList",
            attrs: { start: 2 },
            content: [
              {
                type: "listItem",
                content: [para("Tile"), { type: "hardBreak" }],
              },
            ],
          },
          {
            type: "bulletList",
            content: [{ type: "listItem", content: [para("x")] }],
          },
        ],
      };
      expect(v.validateRichTextDoc(doc)).to.equal(null);
    });

    it("rejects unknown nodes, marks and attrs", function () {
      expect(
        v.validateRichTextDoc({
          type: "doc",
          content: [{ type: "heading", attrs: { level: 1 } }],
        }),
      ).to.match(/heading/);
      expect(
        v.validateRichTextDoc({
          type: "doc",
          content: [
            para("x", [
              { type: "link", attrs: { href: "javascript:alert(1)" } },
            ]),
          ],
        }),
      ).to.match(/link/);
      expect(
        v.validateRichTextDoc({
          type: "doc",
          content: [{ type: "paragraph", attrs: { textAlign: "right" } }],
        }),
      ).to.match(/paragraph\.textAlign/);
      expect(v.validateRichTextDoc({ type: "paragraph" })).to.be.a("string");
      expect(v.validateRichTextDoc("<b>html</b>")).to.be.a("string");
    });

    it("rejects an oversized document", function () {
      const big = { type: "doc", content: [para("x".repeat(70 * 1024))] };
      expect(v.validateRichTextDoc(big)).to.match(/too large/);
    });
  });

  describe("normalizeGeneratePhotos", function () {
    const photo = (overrides) => ({
      fileId: ID_A,
      postId: "64b000000000000000000099",
      dayKey: "2026-08-18",
      uploadedAt: "2026-08-18T15:00:00.000Z",
      note: " Cabinets set. ",
      comments: [
        {
          text: "Uppers hung",
          createdAt: "2026-08-19T10:00:00.000Z",
          isReply: false,
        },
        { text: "", createdAt: "2026-08-19T10:00:00.000Z" },
        {
          text: "Crown next",
          createdAt: "2026-08-19T11:00:00.000Z",
          isReply: true,
        },
      ],
      tags: ["Kitchen", "", 42],
      ...overrides,
    });

    it("coerces and trims a well-formed photo", function () {
      const result = v.normalizeGeneratePhotos([photo()]);
      expect(result.error).to.equal(null);
      expect(result.photos).to.have.length(1);
      const p = result.photos[0];
      expect(p.note).to.equal("Cabinets set.");
      expect(p.comments).to.deep.equal([
        {
          text: "Uppers hung",
          createdAt: "2026-08-19T10:00:00.000Z",
          isReply: false,
        },
        {
          text: "Crown next",
          createdAt: "2026-08-19T11:00:00.000Z",
          isReply: true,
        },
      ]);
      expect(p.tags).to.deep.equal(["Kitchen"]);
      expect(p.dayKey).to.equal("2026-08-18");
    });

    it("rejects a missing dayKey, over-limit and duplicate ids", function () {
      expect(
        v.normalizeGeneratePhotos([photo({ dayKey: undefined })]).error,
      ).to.match(/dayKey/);
      expect(v.normalizeGeneratePhotos([photo(), photo()]).error).to.match(
        /Duplicate/,
      );
      expect(v.normalizeGeneratePhotos("x").error).to.be.a("string");
      expect(v.normalizeGeneratePhotos([]).error).to.be.a("string");
    });

    it("caps comments per photo and total source text", function () {
      const many = Array.from({ length: 80 }, (_, i) => ({
        text: `c${i}`,
        createdAt: "2026-08-19T10:00:00.000Z",
      }));
      const capped = v.normalizeGeneratePhotos([photo({ comments: many })]);
      expect(capped.photos[0].comments).to.have.length(50);

      const huge = v.normalizeGeneratePhotos([
        photo({ note: "x".repeat(31_000) }),
      ]);
      expect(huge.error).to.match(/too long/);
    });
  });

  describe("hasUsableText / countBlankPhotos", function () {
    const blank = {
      fileId: ID_A,
      postId: "",
      dayKey: "2026-08-18",
      uploadedAt: "",
      note: "",
      comments: [],
      tags: [],
    };
    it("treats note, comments or tags as usable", function () {
      expect(v.hasUsableText([blank])).to.equal(false);
      expect(v.hasUsableText([{ ...blank, tags: ["Roof"] }])).to.equal(true);
      expect(
        v.hasUsableText([
          {
            ...blank,
            comments: [{ text: "x", createdAt: "", isReply: false }],
          },
        ]),
      ).to.equal(true);
      expect(v.countBlankPhotos([blank, { ...blank, note: "n" }])).to.equal(1);
    });
  });
});
