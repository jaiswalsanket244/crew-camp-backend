const { expect } = require("chai");

// The two-stage pipeline with a stubbed BAML client: retry policy, guards,
// deadline and the empty path. No OpenAI.
// Run with: NODE_ENV=test npx mocha -r ts-node/register test/aiProjectUpdate
describe("ProjectUpdateService (stubbed client)", function () {
  let ProjectUpdateService;

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

  const input = (overrides) => ({
    language: "en",
    timeZone: "America/Denver",
    startDate: "2026-08-18",
    endDate: "2026-09-05",
    projectName: "Maple St Remodel",
    photos: [
      photo(),
      photo({
        fileId: "64b000000000000000000002",
        dayKey: "2026-08-22",
        uploadedAt: "2026-08-22T15:00:00.000Z",
        note: "Crown installed, cabinets complete.",
      }),
    ],
    ...overrides,
  });

  const FACTS = [
    {
      area: "Kitchen",
      item: "the base and wall cabinets",
      status: "Completed",
      lastDate: "2026-08-22",
      detail: "Set, uppers hung and crown installed.",
    },
  ];

  // Records calls and answers from a queue so a test can script attempt 1 and 2.
  const stub = ({ facts = FACTS, drafts = [], failExtract = null } = {}) => {
    const calls = { extract: [], compose: [] };
    return {
      calls,
      client: {
        ExtractProgress: async (notes, options) => {
          calls.extract.push({ notes, options });
          if (failExtract) throw failExtract;
          return facts;
        },
        ComposeProjectUpdate: async (request, options) => {
          calls.compose.push({ request, options });
          const next = drafts.shift();
          if (!next) throw new Error("unexpected compose call");
          return next;
        },
      },
    };
  };

  before(function () {
    ProjectUpdateService =
      require("../../server/services/llm/projectUpdate").ProjectUpdateService;
  });

  it("accepts a clean draft in one compose call and joins paragraphs", async function () {
    const s = stub({
      drafts: [
        {
          title: "Kitchen Cabinets Complete.",
          paragraphs: [
            "The kitchen cabinets were set and the crown installed.",
            " Nothing remains outstanding. ",
          ],
        },
      ],
    });
    const result = await new ProjectUpdateService(
      s.client,
    ).generateProjectUpdate(input());
    expect(s.calls.extract).to.have.length(1);
    expect(s.calls.compose).to.have.length(1);
    expect(s.calls.extract[0].notes).to.include("### 2026-08-18");
    expect(s.calls.extract[0].options.signal).to.be.instanceOf(AbortSignal);
    expect(result).to.deep.equal({
      title: "Kitchen Cabinets Complete",
      overview:
        "The kitchen cabinets were set and the crown installed.\n\nNothing remains outstanding.",
    });
  });

  it("retries stage 2 exactly once with every correction, then accepts", async function () {
    const s = stub({
      drafts: [
        {
          title: "",
          paragraphs: [
            "Cabinets set.",
            "The job is on track and 45% done.",
            "Third.",
          ],
        },
        {
          title: "Kitchen Cabinets Complete",
          paragraphs: [
            "The kitchen cabinets were set and the crown installed.",
          ],
        },
      ],
    });
    const result = await new ProjectUpdateService(
      s.client,
    ).generateProjectUpdate(input());
    expect(s.calls.compose).to.have.length(2);
    const retry = s.calls.compose[1].request;
    expect(retry).to.include("YOUR PREVIOUS ATTEMPT MUST BE CORRECTED");
    expect(retry).to.include('"on track"');
    expect(retry).to.include("3 paragraphs");
    expect(retry).to.include("title was empty");
    expect(result.title).to.equal("Kitchen Cabinets Complete");
    expect(result.overview).to.equal(
      "The kitchen cabinets were set and the crown installed.",
    );
  });

  it("applies deterministic fixes when the retry is still wrong — never a third call", async function () {
    const bad = {
      title: "On Track Kitchen",
      paragraphs: [
        "Cabinets were set. The job is on track.",
        "Tile is next.",
        "Fourth paragraph.",
      ],
    };
    const s = stub({ drafts: [bad, { ...bad }] });
    const result = await new ProjectUpdateService(
      s.client,
    ).generateProjectUpdate(input());
    expect(s.calls.compose).to.have.length(2);
    expect(result.title).to.equal("");
    expect(result.overview).to.equal(
      "Cabinets were set.\n\nTile is next. Fourth paragraph.",
    );
  });

  it("asks for Spanish and flags an English answer", async function () {
    const english =
      "The cabinets were set and the counters were templated and the tile was delivered from the supplier, which was late.";
    const s = stub({
      drafts: [
        { title: "Kitchen", paragraphs: [english] },
        {
          title: "Gabinetes de cocina instalados",
          paragraphs: [
            "Se instalaron los gabinetes de la cocina y la moldura.",
          ],
        },
      ],
    });
    const result = await new ProjectUpdateService(
      s.client,
    ).generateProjectUpdate(input({ language: "es" }));
    expect(s.calls.compose[0].request).to.include("in Spanish");
    expect(s.calls.compose[1].request).to.include("wrong language");
    expect(result.title).to.equal("Gabinetes de cocina instalados");
  });

  it("returns empty strings and skips stage 2 when nothing was extracted", async function () {
    const s = stub({
      facts: [
        { area: "", item: "", status: "Completed", lastDate: "", detail: "" },
      ],
    });
    const result = await new ProjectUpdateService(
      s.client,
    ).generateProjectUpdate(input());
    expect(result).to.deep.equal({ title: "", overview: "" });
    expect(s.calls.compose).to.have.length(0);
  });

  it("refuses to start a call once the shared deadline is spent", async function () {
    const s = stub({ drafts: [{ title: "x", paragraphs: ["y"] }] });
    let error;
    try {
      await new ProjectUpdateService(s.client, 1).generateProjectUpdate(
        input(),
      );
    } catch (e) {
      error = e;
    }
    expect(error).to.exist;
    expect(error.name).to.equal("TimeoutError");
    expect(s.calls.extract).to.have.length(0);
  });

  it("hands stage 2 less budget than stage 1", async function () {
    const s = stub({
      drafts: [{ title: "x", paragraphs: ["Cabinets were set."] }],
    });
    s.client.ExtractProgress = async (notes, options) => {
      s.calls.extract.push({ notes, options });
      await new Promise((r) => setTimeout(r, 30));
      return FACTS;
    };
    // A 5 s budget: both calls happen, and the second signal was created later
    // (so it fires sooner) than the first.
    await new ProjectUpdateService(s.client, 5_000).generateProjectUpdate(
      input(),
    );
    expect(s.calls.extract[0].options.signal).to.be.instanceOf(AbortSignal);
    expect(s.calls.compose[0].options.signal).to.be.instanceOf(AbortSignal);
    expect(s.calls.compose[0].options.signal).to.not.equal(
      s.calls.extract[0].options.signal,
    );
  });

  it("propagates a stage-1 failure untouched so the route can classify it", async function () {
    const failure = Object.assign(new Error("rate limited"), { status: 429 });
    const s = stub({ failExtract: failure });
    let error;
    try {
      await new ProjectUpdateService(s.client).generateProjectUpdate(input());
    } catch (e) {
      error = e;
    }
    expect(error).to.equal(failure);
  });
});
