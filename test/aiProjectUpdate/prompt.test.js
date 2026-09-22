const { expect } = require("chai");

// Pure prompt assembly + guards for the AI Project Update pipeline.
// Run with: NODE_ENV=test npx mocha -r ts-node/register test/aiProjectUpdate
describe("AI Project Update prompt helpers", function () {
  let m;

  const photo = (overrides) => ({
    fileId: "64b000000000000000000001",
    postId: "64b000000000000000000099",
    dayKey: "2026-08-18",
    uploadedAt: "2026-08-18T15:00:00.000Z",
    note: "Base cabinets set on north wall.",
    comments: [],
    tags: ["Kitchen"],
    ...overrides,
  });

  const input = (photos, overrides) => ({
    language: "en",
    timeZone: "America/Denver",
    startDate: "2026-08-18",
    endDate: "2026-09-05",
    projectName: "Maple St Remodel",
    photos,
    ...overrides,
  });

  before(function () {
    m = require("../../server/services/llm/projectUpdatePrompt");
  });

  describe("dayInZone", function () {
    it("converts an instant to the calendar day in the zone", function () {
      // 03:00Z on the 19th is still the 18th in Denver (UTC-6).
      expect(
        m.dayInZone("2026-08-19T03:00:00.000Z", "America/Denver"),
      ).to.equal("2026-08-18");
      expect(m.dayInZone("2026-08-19T03:00:00.000Z", "UTC")).to.equal(
        "2026-08-19",
      );
    });
    it("degrades to the raw prefix on bad input instead of throwing", function () {
      expect(m.dayInZone("", "UTC")).to.equal("");
      expect(m.dayInZone("not-a-date", "UTC")).to.equal("not-a-date");
      expect(m.dayInZone("2026-08-19T03:00:00.000Z", "Mars/Olympus")).to.equal(
        "2026-08-19",
      );
    });
  });

  describe("renderNotesByDay", function () {
    it("groups by day oldest-first, numbers continuously, dates comments", function () {
      const text = m.renderNotesByDay(
        input([
          photo({
            fileId: "c",
            dayKey: "2026-08-22",
            uploadedAt: "2026-08-22T10:00:00Z",
            note: "Crown installed, cabinets complete.",
            tags: ["Kitchen", "Cabinets"],
          }),
          photo({
            fileId: "a",
            dayKey: "2026-08-18",
            uploadedAt: "2026-08-18T15:00:00Z",
            comments: [
              {
                text: "Uppers hung, crown still needed.",
                createdAt: "2026-08-19T16:00:00.000Z",
                isReply: false,
              },
            ],
          }),
          photo({
            fileId: "b",
            dayKey: "2026-08-18",
            uploadedAt: "2026-08-18T09:00:00Z",
            note: "",
            tags: [],
          }),
        ]),
      );
      const lines = text.split("\n");
      expect(lines[0]).to.equal("Project: Maple St Remodel");
      expect(lines[1]).to.match(
        /^Period: 2026-08-18 to 2026-09-05 \(2 day\(s\) with photos, 3 photo\(s\)\)$/,
      );
      const day1 = text.indexOf("### 2026-08-18 (2 photo(s))");
      const day2 = text.indexOf("### 2026-08-22 (1 photo(s))");
      expect(day1).to.be.greaterThan(-1);
      expect(day2).to.be.greaterThan(day1);
      // Within the day, earlier upload first; the blank photo is marked.
      expect(text).to.include("1. [no notes recorded]");
      expect(text).to.include("2. [Kitchen] Base cabinets set on north wall.");
      expect(text).to.include(
        "   - Comment (2026-08-19): Uppers hung, crown still needed.",
      );
      expect(text).to.include(
        "3. [Kitchen, Cabinets] Crown installed, cabinets complete.",
      );
    });
  });

  describe("renderFactBlock", function () {
    it("orders by status, numbers continuously, skips empty groups and unknown statuses", function () {
      const block = m.renderFactBlock([
        {
          area: "Kitchen",
          item: "cabinets",
          status: "Outstanding",
          lastDate: "2026-08-18",
          detail: "Crown needed.",
        },
        {
          area: "Bath",
          item: "tile",
          status: "Completed",
          lastDate: "2026-08-20",
          detail: "Floor tile set and grouted.",
        },
        { area: "X", item: "y", status: "Bogus", lastDate: "", detail: "z" },
      ]);
      expect(block.indexOf("COMPLETED (1):")).to.be.lessThan(
        block.indexOf("OUTSTANDING (1):"),
      );
      expect(block).to.include(
        "  1. [Bath] tile — Floor tile set and grouted. (last noted 2026-08-20)",
      );
      expect(block).to.include(
        "  2. [Kitchen] cabinets — Crown needed. (last noted 2026-08-18)",
      );
      expect(block).to.not.include("IN PROGRESS");
      expect(block).to.not.include("Bogus");
    });
  });

  describe("partialNote", function () {
    const blank = photo({ note: "", tags: [], comments: [] });
    it("flags partial at >= 30% blank photos, otherwise forbids the claim", function () {
      expect(m.partialNote([blank, photo(), photo()])).to.match(
        /^1 of 3 photos carry no notes/,
      );
      expect(m.partialNote([blank, photo(), photo(), photo()])).to.match(
        /Do NOT add any sentence/,
      );
      expect(m.partialNote([])).to.match(/Do NOT add any sentence/);
    });
  });

  describe("buildComposeRequest", function () {
    it("names the language, includes the fact block and any corrections", function () {
      const facts = [
        {
          area: "Bath",
          item: "tile",
          status: "Completed",
          lastDate: "",
          detail: "Set.",
        },
      ];
      const plain = m.buildComposeRequest(
        input([photo()], { language: "es" }),
        facts,
      );
      expect(plain).to.include("Period: 2026-08-18 to 2026-09-05");
      expect(plain).to.include("in Spanish");
      expect(plain).to.include("COMPLETED (1):");
      expect(plain).to.not.include("PREVIOUS ATTEMPT");
      const retry = m.buildComposeRequest(input([photo()]), facts, [
        "Too long.",
        "Wrong language.",
      ]);
      expect(retry).to.include(
        "YOUR PREVIOUS ATTEMPT MUST BE CORRECTED:\n  - Too long.\n  - Wrong language.",
      );
    });
  });

  describe("guards", function () {
    it("countWords", function () {
      expect(m.countWords("  one two\n\nthree ")).to.equal(3);
      expect(m.countWords("")).to.equal(0);
    });

    it("findForbiddenPhrases catches schedule claims and percentages in both languages", function () {
      expect(
        m.findForbiddenPhrases("Work is on track and 45% complete."),
      ).to.deep.equal(["on track", "45%"]);
      expect(
        m.findForbiddenPhrases("Vamos según lo previsto y a tiempo."),
      ).to.have.length(2);
      expect(
        m.findForbiddenPhrases("Cabinets set on the north wall."),
      ).to.deep.equal([]);
    });

    it("dropForbiddenSentences removes only the offending sentence", function () {
      expect(
        m.dropForbiddenSentences(
          "Cabinets were set. The project is on track. Tile starts next.",
        ),
      ).to.equal("Cabinets were set. Tile starts next.");
      expect(m.dropForbiddenSentences("Everything is 80% done")).to.equal("");
      expect(m.dropForbiddenSentences("No punctuation at all")).to.equal(
        "No punctuation at all",
      );
    });

    it("clampParagraphs folds extras into the second paragraph", function () {
      expect(m.clampParagraphs([" a ", "", "b"])).to.deep.equal(["a", "b"]);
      expect(m.clampParagraphs(["a", "b", "c", "d"])).to.deep.equal([
        "a",
        "b c d",
      ]);
    });

    it("cleanTitle trims, drops the trailing period and caps length", function () {
      expect(m.cleanTitle("  Kitchen   Finishes Underway. ")).to.equal(
        "Kitchen Finishes Underway",
      );
      expect(m.cleanTitle("x".repeat(200))).to.have.length(120);
    });
  });

  describe("collectCorrections", function () {
    it("returns nothing for a clean draft", function () {
      expect(
        m.collectCorrections(
          {
            title: "Kitchen Finishes Underway",
            paragraphs: ["Cabinets were set and the counters were templated."],
          },
          "en",
        ),
      ).to.deep.equal([]);
    });

    it("collects every problem at once for a single retry", function () {
      const english =
        "The cabinets were set and the counters were templated and the tile was delivered from the supplier, which was late.";
      const corrections = m.collectCorrections(
        {
          title: "",
          paragraphs: [
            english,
            "The job is on track.",
            "Third paragraph.",
            `Fourth ${"word ".repeat(230)}`,
          ],
        },
        "es",
      );
      const joined = corrections.join("\n");
      expect(joined).to.include("wrong language");
      expect(joined).to.include("Spanish");
      expect(joined).to.include("4 paragraphs");
      expect(joined).to.match(/It was \d+ words/);
      expect(joined).to.include('"on track"');
      expect(joined).to.include("title was empty");
    });
  });

  describe("GenerationDeadline", function () {
    it("hands each call the remaining budget and refuses when too little is left", function () {
      const d = new m.GenerationDeadline(50_000, 1_000_000);
      expect(d.remainingMs(1_010_000)).to.equal(40_000);
      const opts = d.callOptions(1_010_000);
      expect(opts.signal).to.be.instanceOf(AbortSignal);
      expect(opts.signal.aborted).to.equal(false);
      expect(() => d.callOptions(1_048_000)).to.throw(m.TimeoutError);
      try {
        d.callOptions(1_060_000);
      } catch (error) {
        expect(error.name).to.equal("TimeoutError");
      }
    });
  });
});
