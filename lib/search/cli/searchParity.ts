import mongoose, { Types } from "mongoose";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { ProjectRoutes } from "../../routes/projects/routes";
import { PostsRoutes } from "../../routes/posts/routes";
import { Company, CompanyMember, ProjectMember } from "../../db";
import { USER_ROLE } from "../../utils/enums/enums";
import { QUERY_FIXTURES, QueryFixture } from "../parity/fixtures";
import { SORT_TYPE } from "../../utils/enums/post";

// Parity + latency runner for the ES↔Mongo read path. For a target company it drives BOTH paths of each migrated handler over the fixtures — forcing ES then Mongo via searchWithFallback's `forcePath` (so it works today while the flag stub is off) — times each (the staging speed signal), and structurally diffs the two SuccessResponse payloads honoring each fixture's `tolerance`. It invokes the REAL handlers through a mock req/res so the comparison includes the handler's post-fetch enrichment (which is path-agnostic — the projects op-map re-fetches counts for both paths).

type ForcePath = "es" | "mongo";

export interface LatencyStats {
  p50: number;
  p95: number;
  max: number;
}

export interface ParityDetail {
  fixtureName: string;
  route: QueryFixture["route"];
  status: "pass" | "fail" | "error";
  esLatencyMs: number | null;
  mongoLatencyMs: number | null;
  // true when the handler routed the "ES" path back to Mongo (guest / posts timestamp-sort) — the es-forced run is a Mongo query, so it is excluded from the ES latency aggregate.
  esRanMongo?: boolean;
  resultCount: { es: number; mongo: number };
  diff?: unknown;
  error?: string;
}

export interface ParityReport {
  companyId: string;
  route: "projects.list" | "posts.uploads" | "all";
  fixtureCount: number;
  passed: number;
  failed: number;
  errored: number;
  esLatency: LatencyStats;
  mongoLatency: LatencyStats;
  details: ParityDetail[];
}

interface RunParityOpts {
  companyId: ObjectIdType;
  route?: "projects.list" | "posts.uploads" | "all";
  fixtures?: QueryFixture[];
  userId?: ObjectIdType;
}

// Real actors for a faithful req.user (mirrors auth.ts): ownerId = Company.userId (the subscription chokepoint → req.user.adminId); memberId = a real LIMITED/CREW member WITH project memberships, so the Mongo role-scoping (getMyProjects(_id)) returns a real set instead of [] (the es:50/mongo:0 gap).
interface Actors {
  ownerId: ObjectIdType;
  memberId: ObjectIdType;
}

// Minimal mock req the two handlers read (query, user, headers, isExternalRequest, parityForcePath).
const buildReq = (
  fixture: QueryFixture,
  companyId: ObjectIdType,
  actors: Actors,
  forcePath: ForcePath,
): Record<string, unknown> => {
  const role = fixture.actor.companyRole;
  // posts.uploads guests have NO companyId (they bypass searchWithFallback). projects always needs a req.user (it reads user.companies[0]); a projects "GUEST" is driven by input.role="GUEST".
  const guestUploads = fixture.route === "posts.uploads" && role === "GUEST";
  const isMember = role === "LIMITED" || role === "CREW";
  const user = guestUploads
    ? undefined
    : {
        _id: isMember ? actors.memberId : actors.ownerId,
        companyId,
        companies: [{ companyId, role }],
        adminId: actors.ownerId, // auth.ts: adminId = company owner (subscription owner)
      };
  return {
    query: { ...fixture.input },
    user,
    headers: {},
    isExternalRequest: false,
    parityForcePath: forcePath,
  };
};

// Mock res capturing SuccessResponse (res.status().json()) + a no-op `once` for instrumentBaselineLatency.
const captureRes = () => {
  const captured: { code?: number; payload?: { data?: unknown } } = {};
  const res: Record<string, unknown> = {
    status(code: number) {
      captured.code = code;
      return res;
    },
    json(payload: { data?: unknown }) {
      captured.payload = payload;
      return res;
    },
    once() {
      return res;
    },
    on() {
      return res;
    },
    set() {
      return res;
    },
  };
  return { res, captured };
};

// Invoke a handler once for a forced path; return its latency + captured response data (or error).
const runHandler = async (
  fixture: QueryFixture,
  companyId: ObjectIdType,
  actors: Actors,
  forcePath: ForcePath,
): Promise<{ ms: number; data?: unknown; error?: string }> => {
  const handler =
    fixture.route === "projects.list"
      ? ProjectRoutes.getAllDataV2
      : PostsRoutes.getUploads;
  const req = buildReq(fixture, companyId, actors, forcePath);
  const { res, captured } = captureRes();
  let captErr: string | undefined;
  const next = (err: unknown) => {
    captErr =
      err instanceof Error ? err.message : err ? String(err) : "unknown error";
  };
  const start = Date.now();
  try {
    await (handler as (r: unknown, s: unknown, n: unknown) => Promise<unknown>)(
      req,
      res,
      next,
    );
  } catch (e) {
    // A handler that THROWS/rejects (not just next(err)) must not abort the whole run.
    return {
      ms: Date.now() - start,
      error: e instanceof Error ? e.message : e ? String(e) : "thrown error",
    };
  }
  const ms = Date.now() - start;
  if (captErr) {
    return { ms, error: captErr };
  }
  return { ms, data: captured.payload?.data };
};

// Pull the comparable item rows out of a route's response payload.data (projects: {data:rows}; uploads: date-buckets {_id, posts:[...]}, flattened to posts). Both carry per-row `_id`s for matching.
const extractItems = (
  route: QueryFixture["route"],
  data: unknown,
): { _id: string; row: Record<string, unknown> }[] => {
  if (route === "projects.list") {
    const rows = (data as { data?: unknown[] })?.data ?? [];
    return (Array.isArray(rows) ? rows : []).map((r) => ({
      _id: String((r as { _id?: unknown })?._id ?? ""),
      row: r as Record<string, unknown>,
    }));
  }
  // posts.uploads: data is the page-wrapper array [{ items:[{_id:date, posts:[...]}], total, … }]; the date buckets live at data[0].items, each carrying a `posts` array (the per-post rows).
  const page = Array.isArray(data)
    ? (data[0] as { items?: unknown[] })
    : undefined;
  const buckets = Array.isArray(page?.items) ? page.items : [];
  const out: { _id: string; row: Record<string, unknown> }[] = [];
  buckets.forEach((b) => {
    const posts = (b as { posts?: unknown[] })?.posts ?? [];
    (Array.isArray(posts) ? posts : []).forEach((p) =>
      out.push({
        _id: String((p as { _id?: unknown })?._id ?? ""),
        row: p as Record<string, unknown>,
      }),
    );
  });
  return out;
};

// Recursively drop tolerance.ignoreFields, then JSON-serialize for a stable compare.
const stripFields = (value: unknown, ignore: Set<string>): unknown => {
  if (Array.isArray(value)) {
    return value.map((v) => stripFields(v, ignore));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    Object.keys(value as Record<string, unknown>)
      .filter((k) => !ignore.has(k))
      // null/undefined ≡ absent: the ES path emits explicit `archivedAt: null` etc. where the Mongo lean docs omit the key — same meaning to any client, so don't flag it as a field mismatch.
      .filter((k) => (value as Record<string, unknown>)[k] != null)
      .sort() // canonical key order so ES-built vs Mongo-lean objects compare by value, not key order
      .forEach((k) => {
        out[k] = stripFields((value as Record<string, unknown>)[k], ignore);
      });
    return out;
  }
  return value;
};

// Diff the ES vs Mongo item sets honoring tolerance: ignoreFields (strip), ignoreOrder (set-compare by _id), maxResultDiff (allowed count of only-on-one-side rows). Returns pass + a structured diff.
const diffItems = (
  esItems: { _id: string; row: Record<string, unknown> }[],
  mongoItems: { _id: string; row: Record<string, unknown> }[],
  tolerance: QueryFixture["tolerance"],
): { pass: boolean; diff?: unknown } => {
  const ignore = new Set(tolerance.ignoreFields ?? []);
  // JSON round-trip FIRST so ObjectId→hex string and Date→ISO string — i.e. what the client
  // actually receives on the wire. Without it, stripFields rebuilds ObjectIds via Object.keys()
  // (which is []), collapsing every _id/companyId/tags to {} and failing every real-doc compare
  // (Mongo rows hold ObjectIds; ES rows hold strings). stripFields then drops ignored/null + sorts.
  const ser = (r: Record<string, unknown>) =>
    JSON.stringify(stripFields(JSON.parse(JSON.stringify(r)), ignore));
  const esById = new Map(esItems.map((i) => [i._id, ser(i.row)]));
  const mongoById = new Map(mongoItems.map((i) => [i._id, ser(i.row)]));

  const onlyEs = Array.from(esById.keys()).filter((id) => !mongoById.has(id));
  const onlyMongo = Array.from(mongoById.keys()).filter(
    (id) => !esById.has(id),
  );
  const fieldMismatch = Array.from(esById.keys()).filter(
    (id) => mongoById.has(id) && esById.get(id) !== mongoById.get(id),
  );

  // Order check only when ignoreOrder is not set.
  const orderMismatch = tolerance.ignoreOrder
    ? false
    : esItems.map((i) => i._id).join(",") !==
      mongoItems.map((i) => i._id).join(",");

  const maxResultDiff = tolerance.maxResultDiff ?? 0;
  const pass =
    fieldMismatch.length === 0 &&
    !orderMismatch &&
    onlyEs.length + onlyMongo.length <= maxResultDiff;

  if (pass) {
    return { pass: true };
  }
  return {
    pass: false,
    diff: {
      onlyInEs: onlyEs.slice(0, 10),
      onlyInMongo: onlyMongo.slice(0, 10),
      fieldMismatchIds: fieldMismatch.slice(0, 10),
      orderMismatch,
      counts: { es: esItems.length, mongo: mongoItems.length },
    },
  };
};

const stats = (samples: number[]): LatencyStats => {
  if (!samples.length) {
    return { p50: 0, p95: 0, max: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
};

// Resolve REAL actors so req.user is faithful (auth.ts). Gated on a live Mongo connection: the stubbed unit tests have no DB, so they fall back to the companyId-as-actor (the handlers are stubbed there anyway). On staging the lookups give the real owner + a real member-with-projects, without which the Mongo role-scoping under-returns (es:N/mongo:0).
const resolveActors = async (companyId: ObjectIdType): Promise<Actors> => {
  const fallback: Actors = { ownerId: companyId, memberId: companyId };
  if (mongoose.connection.readyState !== 1) {
    return fallback;
  }
  try {
    const company = await Company.findById(companyId, { userId: 1 }).lean();
    const ownerId = ((company as { userId?: ObjectIdType } | null)?.userId ??
      companyId) as ObjectIdType;
    let memberId: ObjectIdType = ownerId;
    const members = await CompanyMember.find(
      { companyId, role: { $in: [USER_ROLE.LIMITED, USER_ROLE.CREW] } },
      { userId: 1 },
    ).lean();
    for (const m of members as Array<{ userId?: ObjectIdType }>) {
      if (m.userId && (await ProjectMember.exists({ userId: m.userId }))) {
        memberId = m.userId;
        break;
      }
    }
    return { ownerId, memberId };
  } catch {
    return fallback;
  }
};

// Run the parity + latency sweep for a company. Calls each fixture's handler twice (Mongo-forced then ES-forced), times both, diffs the results, and aggregates pass/fail + latency percentiles.
export const runParity = async (opts: RunParityOpts): Promise<ParityReport> => {
  const route = opts.route ?? "all";
  // Coerce to ObjectId: the CLI passes --company-id as a STRING, but the Mongo path runs Project.aggregate, whose $match does NOT auto-cast strings → a string companyId matches NOTHING (the es:50/mongo:0 divergence seen in the staging run). The ES path is unaffected (the builder does companyId.toString()). Unit-test callers already pass ObjectIds; String()→ObjectId is a no-op there.
  const companyId = new Types.ObjectId(String(opts.companyId));
  const actors = await resolveActors(companyId);
  const fixtures = (opts.fixtures ?? QUERY_FIXTURES).filter(
    (f) => route === "all" || f.route === route,
  );

  const details: ParityDetail[] = [];
  const esSamples: number[] = [];
  const mongoSamples: number[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;

  for (const fixture of fixtures) {
    const mongoRun = await runHandler(fixture, companyId, actors, "mongo");
    const esRun = await runHandler(fixture, companyId, actors, "es");

    if (mongoRun.error || esRun.error) {
      errored += 1;
      details.push({
        fixtureName: fixture.name,
        route: fixture.route,
        status: "error",
        esLatencyMs: esRun.error ? null : esRun.ms,
        mongoLatencyMs: mongoRun.error ? null : mongoRun.ms,
        resultCount: { es: 0, mongo: 0 },
        error: esRun.error || mongoRun.error,
      });
      continue;
    }

    // The handler routes the ES path back to Mongo for guests (no companyId / guest scope) and for posts timestamp-sort — so the es-forced run is a Mongo query. Keep its per-fixture number but exclude it from the ES latency aggregate so the ES speed signal isn't polluted with Mongo ms.
    const esRanMongo =
      fixture.actor.companyRole === "GUEST" ||
      (fixture.route === "posts.uploads" &&
        (fixture.input.sortBy === SORT_TYPE.DATE_TAKEN_ASC ||
          fixture.input.sortBy === SORT_TYPE.DATE_TAKEN_DESC));
    if (!esRanMongo) {
      esSamples.push(esRun.ms);
    }
    mongoSamples.push(mongoRun.ms);
    const esItems = extractItems(fixture.route, esRun.data);
    const mongoItems = extractItems(fixture.route, mongoRun.data);
    const { pass, diff } = diffItems(esItems, mongoItems, fixture.tolerance);
    if (pass) {
      passed += 1;
    } else {
      failed += 1;
    }
    details.push({
      fixtureName: fixture.name,
      route: fixture.route,
      status: pass ? "pass" : "fail",
      esLatencyMs: esRun.ms,
      mongoLatencyMs: mongoRun.ms,
      esRanMongo,
      resultCount: { es: esItems.length, mongo: mongoItems.length },
      diff: pass ? undefined : diff,
    });
  }

  return {
    companyId: opts.companyId.toString(),
    route,
    fixtureCount: fixtures.length,
    passed,
    failed,
    errored,
    esLatency: stats(esSamples),
    mongoLatency: stats(mongoSamples),
    details,
  };
};
