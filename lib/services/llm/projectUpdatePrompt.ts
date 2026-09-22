import {
  DAILY_LOG_LANGUAGE,
  DAILY_LOG_LANGUAGE_NAME,
} from "../../utils/enums/dailyLog";
import {
  IAiProjectUpdateGenerateInput,
  IPhotoSource,
} from "../../utils/interfaces/aiProjectUpdate";
import { looksWrongLanguage } from "./dailyLog";

// Pure helpers for the project-update pipeline: prompt assembly, the
// deterministic guards that run after the model, and the shared deadline.
// No BAML, no Mongo — everything here is unit-testable with fixtures.

// ---- limits the guards enforce ----
export const MAX_PARAGRAPHS = 2;
export const MAX_WORDS = 220;
export const TARGET_WORDS = "60 to 160";
export const TITLE_MAX_LENGTH = 120;

// A photo with neither note, comments nor tags told the model nothing. When a
// real share of the period is like that, the update is genuinely partial and
// may say so once; otherwise saying so would be a false statement.
export const PARTIAL_THRESHOLD = 0.3;

// Assessments and claims the facts can never support (rule 4). Matched
// case-insensitively against each sentence.
export const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bon[- ]track\b/i,
  /\bon[- ]schedule\b/i,
  /\bahead of schedule\b/i,
  /\bbehind schedule\b/i,
  /\b\d{1,3}\s?%/,
  /\b\d{1,3}\s?(percent|por ciento)\b/i,
  /\bseg[uú]n lo (previsto|programado|planeado)\b/i,
  /\ba tiempo\b/i,
  /\beverything else is (proceeding|progressing|moving)\b/i,
];

// ---- shared deadline ----

const MIN_CALL_BUDGET_MS = 3_000;

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
    // ES5 target: Error subclasses lose their prototype chain after super(),
    // so restore it or `instanceof TimeoutError` is false.
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

// One budget for the whole generation. Each model call gets whatever is left,
// so two stages plus one retry can never add up past the route's promise to
// the client (the frontend aborts at 60 s; this stays under it).
export class GenerationDeadline {
  private readonly endsAt: number;

  constructor(budgetMs: number, now: number = Date.now()) {
    this.endsAt = now + budgetMs;
  }

  remainingMs(now: number = Date.now()): number {
    return this.endsAt - now;
  }

  // Throws TimeoutError (retryable at the route) when too little budget is
  // left for a call to be worth starting.
  callOptions(now: number = Date.now()): { signal: AbortSignal } {
    const remaining = this.remainingMs(now);
    if (remaining < MIN_CALL_BUDGET_MS) {
      throw new TimeoutError("generation deadline exceeded");
    }
    return { signal: AbortSignal.timeout(remaining) };
  }
}

// ---- stage 1 input ----

// YYYY-MM-DD of an ISO instant in the given zone; falls back to the raw text
// (or "") when either is unusable, so a bad comment date never aborts a run.
export const dayInZone = (iso: string, timeZone: string): string => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return iso.slice(0, 10);
  }
};

const byUploadedAt = (a: IPhotoSource, b: IPhotoSource): number =>
  (a.uploadedAt || "").localeCompare(b.uploadedAt || "");

// Photos grouped by day, oldest first, numbered continuously. Comments carry
// their own date so the model can see when a status changed.
export const renderNotesByDay = (
  input: IAiProjectUpdateGenerateInput,
): string => {
  const days = new Map<string, IPhotoSource[]>();
  for (const photo of input.photos) {
    const group = days.get(photo.dayKey);
    if (group) group.push(photo);
    else days.set(photo.dayKey, [photo]);
  }
  const dayKeys = Array.from(days.keys()).sort();

  const header = [
    input.projectName ? `Project: ${input.projectName}` : "",
    input.projectAddress ? `Address: ${input.projectAddress}` : "",
    `Period: ${input.startDate} to ${input.endDate} (${dayKeys.length} day(s) with photos, ${input.photos.length} photo(s))`,
  ]
    .filter(Boolean)
    .join("\n");

  let index = 0;
  const blocks = dayKeys.map((dayKey) => {
    const photos = (days.get(dayKey) ?? []).sort(byUploadedAt);
    const lines = photos.map((photo) => {
      index += 1;
      const tags = photo.tags.length ? ` [${photo.tags.join(", ")}]` : "";
      const note = photo.note || "[no notes recorded]";
      const parts = [`${index}.${tags} ${note}`];
      for (const comment of photo.comments) {
        const label = comment.isReply ? "Reply" : "Comment";
        const day = dayInZone(comment.createdAt, input.timeZone);
        parts.push(`   - ${label}${day ? ` (${day})` : ""}: ${comment.text}`);
      }
      return parts.join("\n");
    });
    return `### ${dayKey} (${photos.length} photo(s))\n${lines.join("\n")}`;
  });

  return `${header}\n\n${blocks.join("\n\n")}`;
};

// ---- stage 2 input ----

// The shape stage 1 returns. Declared here (not imported from baml_client) so
// this module stays free of generated code and testable with plain objects.
export interface IProgressFact {
  area: string;
  item: string;
  status: string;
  lastDate: string;
  detail: string;
}

const STATUS_ORDER: { key: string; label: string }[] = [
  { key: "Completed", label: "COMPLETED" },
  { key: "InProgress", label: "IN PROGRESS" },
  { key: "Outstanding", label: "OUTSTANDING" },
  { key: "Blocked", label: "BLOCKED (waiting on someone or something)" },
  { key: "Unclear", label: "UNCLEAR (notes conflict — mention only as to be confirmed, or omit)" },
];

export const renderFactBlock = (facts: IProgressFact[]): string => {
  let index = 0;
  return STATUS_ORDER.map(({ key, label }) => {
    const group = facts.filter((fact) => fact.status === key);
    if (!group.length) return "";
    const lines = group.map((fact) => {
      index += 1;
      const when = fact.lastDate ? ` (last noted ${fact.lastDate})` : "";
      return `  ${index}. [${fact.area}] ${fact.item} — ${fact.detail}${when}`;
    });
    return `${label} (${group.length}):\n${lines.join("\n")}`;
  })
    .filter(Boolean)
    .join("\n\n");
};

export const partialNote = (photos: IPhotoSource[]): string => {
  const blank = photos.filter(
    (photo) => !photo.note && !photo.comments.length && !photo.tags.length,
  ).length;
  const partial =
    photos.length > 0 && blank / photos.length >= PARTIAL_THRESHOLD;
  return partial
    ? `${blank} of ${photos.length} photos carry no notes, so part of this period is undocumented. Close the last paragraph with exactly one short sentence saying that some work in the period was not written up, without naming photos, notes or tags.`
    : `Every photo that matters carries notes. Do NOT add any sentence claiming work is missing or undescribed.`;
};

export const buildComposeRequest = (
  input: IAiProjectUpdateGenerateInput,
  facts: IProgressFact[],
  corrections: string[] = [],
): string => {
  const languageName = DAILY_LOG_LANGUAGE_NAME[input.language];
  const header = [
    input.projectName ? `Project: ${input.projectName}` : "",
    `Period: ${input.startDate} to ${input.endDate}`,
  ]
    .filter(Boolean)
    .join("\n");

  const retry = corrections.length
    ? `\n\nYOUR PREVIOUS ATTEMPT MUST BE CORRECTED:\n${corrections
        .map((line) => `  - ${line}`)
        .join("\n")}`
    : "";

  return `${header}

The notes have already been read. Below is what they establish, grouped by
the status each item had at the END of the period. Write only from this list.
Add nothing that is not on it.

${renderFactBlock(facts)}

LANGUAGE: write the title and every paragraph in ${languageName}, keeping
proper nouns, area and unit labels, and trade terms exactly as written.

${partialNote(input.photos)}${retry}`;
};

// ---- guards ----

export const countWords = (text: string): number =>
  text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

export const findForbiddenPhrases = (text: string): string[] =>
  FORBIDDEN_PATTERNS.map((pattern) => text.match(pattern)?.[0] ?? "").filter(
    Boolean,
  );

// Sentence-level removal for the post-retry fallback. A sentence is a run of
// text up to terminal punctuation (or the end); good enough for prose of this
// length, and written without lookbehind for the ES5 target.
const SENTENCE = /[^.!?]+[.!?]+|[^.!?]+$/g;

export const dropForbiddenSentences = (paragraph: string): string =>
  (paragraph.match(SENTENCE) ?? [])
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence && !FORBIDDEN_PATTERNS.some((p) => p.test(sentence)),
    )
    .join(" ")
    .trim();

// Trim, drop empties, and fold anything past MAX_PARAGRAPHS into the last
// allowed paragraph rather than losing it.
export const clampParagraphs = (paragraphs: string[]): string[] => {
  const clean = paragraphs.map((p) => p.trim()).filter(Boolean);
  if (clean.length <= MAX_PARAGRAPHS) return clean;
  const head = clean.slice(0, MAX_PARAGRAPHS - 1);
  const tail = clean.slice(MAX_PARAGRAPHS - 1).join(" ");
  return [...head, tail];
};

export const cleanTitle = (title: string): string =>
  title
    .trim()
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .slice(0, TITLE_MAX_LENGTH);

export interface IDraft {
  title: string;
  paragraphs: string[];
}

// Every problem with a draft, as a correction line for ONE retry. Empty means
// the draft is accepted as is.
export const collectCorrections = (
  draft: IDraft,
  language: DAILY_LOG_LANGUAGE,
): string[] => {
  const corrections: string[] = [];
  const paragraphs = draft.paragraphs.map((p) => p.trim()).filter(Boolean);
  const text = paragraphs.join("\n\n");
  const languageName = DAILY_LOG_LANGUAGE_NAME[language];

  if (text && looksWrongLanguage(text, language)) {
    corrections.push(
      `It was in the wrong language. Write every word, including the title, in ${languageName}.`,
    );
  }
  if (paragraphs.length > MAX_PARAGRAPHS) {
    corrections.push(
      `It had ${paragraphs.length} paragraphs. Return at most ${MAX_PARAGRAPHS}.`,
    );
  }
  const words = countWords(text);
  if (words > MAX_WORDS) {
    corrections.push(
      `It was ${words} words. Shorten it to ${TARGET_WORDS} words by dropping detail, not by dropping items.`,
    );
  }
  const phrases = findForbiddenPhrases(`${draft.title}\n${text}`);
  if (phrases.length) {
    corrections.push(
      `It contained claims the facts cannot support: ${phrases
        .map((p) => `"${p}"`)
        .join(", ")}. Remove them and any assessment of schedule or completion.`,
    );
  }
  if (!draft.title.trim() && paragraphs.length) {
    corrections.push("The title was empty. Provide a 3-8 word headline.");
  }
  return corrections;
};
