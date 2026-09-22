import { b as baml } from "../../baml_client";
import { ExtractedJob } from "../../baml_client/types";
import {
  DailyLogGenerateMode,
  IDailyLogGenerateInput,
  IDailyLogGeneratePhoto,
  IDailyLogGenerateResult,
  IDailyLogLLMService,
} from "../../utils/interfaces/dailyLog";
import {
  DAILY_LOG_LANGUAGE,
  DAILY_LOG_LANGUAGE_NAME,
} from "../../utils/enums/dailyLog";

const REQUEST_TIMEOUT_MS = 45_000;

const withTimeout = () => ({
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});

// Case- and punctuation-insensitive key, so "Seal the grout line." and
// "seal the grout line" collapse to one item.
// A photo with neither a description nor tags told the model nothing. Only when
// a real share of the day is like that is the log genuinely partial — and that
// is arithmetic, not a judgement call.
const LANGUAGE_MARKERS: Record<string, string[]> = {
  en: ["the", "and", "was", "were", "with", "of", "from", "into", "which"],
  es: ["el", "la", "los", "las", "del", "que", "con", "por", "para", "fue"],
};
// Only act on a clear result. A near tie means the check is unsure, and a
// needless retry costs a second call for nothing.
const LANGUAGE_MIN_MARKERS = 4;
const LANGUAGE_MARGIN = 1.5;

const countMarkers = (text: string, words: string[]): number => {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\s]/gu, " ")} `;
  return words.reduce(
    (total, word) => total + (lower.split(` ${word} `).length - 1),
    0,
  );
};

// Returns true only when the text is confidently in a language OTHER than the
// one asked for. Unsure -> false, so the caller does not retry.
export const looksWrongLanguage = (
  text: string,
  target: DAILY_LOG_LANGUAGE,
): boolean => {
  const other = target === "es" ? "en" : "es";
  const targetHits = countMarkers(text, LANGUAGE_MARKERS[target]);
  const otherHits = countMarkers(text, LANGUAGE_MARKERS[other]);
  if (otherHits < LANGUAGE_MIN_MARKERS) return false;
  return otherHits > targetHits * LANGUAGE_MARGIN;
};

type IExtractedJob = ExtractedJob;

const PARTIAL_LOG_THRESHOLD = 0.3;

const normaliseTodo = (todo: string): string =>
  todo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

class DailyLogService implements IDailyLogLLMService {
  // Only the requested sections go into the schema, so `strict` can require
  // every property and the model can't return a section nobody asked for.

  // Chronological, so the listing follows the working day. Photos without a
  // timestamp keep their incoming position at the end rather than sorting to
  // the front on a falsy comparison.
  private inTimeOrder = (photos: IDailyLogGeneratePhoto[]) =>
    [...photos].sort((a, b) => {
      if (!a.takenAt && !b.takenAt) return 0;
      if (!a.takenAt) return 1;
      if (!b.takenAt) return -1;
      return a.takenAt.localeCompare(b.takenAt);
    });

  // One definition, used by both prompts. Computed here and stated as fact —
  // left to itself the model claimed work was undescribed on fully covered
  // days, which is a false statement in a customer document.
  private partialNote = (
    input: IDailyLogGenerateInput,
    closing: string,
  ): string => {
    const blank = input.photos.filter(
      (photo) => !photo.description?.trim() && !photo.tags?.length,
    ).length;
    const partial =
      input.photos.length > 0 &&
      blank / input.photos.length >= PARTIAL_LOG_THRESHOLD;
    return partial
      ? `${blank} of ${input.photos.length} photos carry no notes, so the log IS partial. Close ${closing} with exactly one short sentence saying so, without naming photos, notes or tags.`
      : `Every photo that matters carries notes. The log is NOT partial — do NOT add any sentence claiming work is missing or undescribed.`;
  };

  private buildAppendPrompt = (input: IDailyLogGenerateInput): string => {
    const asked = input.sections.join(" and ");
    const languageName = DAILY_LOG_LANGUAGE_NAME[input.language];

    const photoLines = this.inTimeOrder(input.photos)
      .map((photo, index) => {
        const description = photo.description?.trim();
        const tags = photo.tags?.filter(Boolean) ?? [];
        const marker = photo.isNew ? " [NEW]" : " [already described]";
        const parts = [
          `Photo ${index + 1}${marker}: ${description || "[no notes recorded]"}`,
        ];
        if (tags.length) parts.push(`  Tags: ${tags.join(", ")}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const context = [
      input.projectName ? `Project: ${input.projectName}` : "",
      input.projectAddress ? `Address: ${input.projectAddress}` : "",
      `Date: ${input.date}`,
    ]
      .filter(Boolean)
      .join("\n");

    const existing = [
      input.existingOverview?.trim()
        ? `EXISTING OVERVIEW (read-only, do not restate):\n${input.existingOverview.trim()}`
        : "EXISTING OVERVIEW: (empty)",
      input.existingTodos?.length
        ? `TO-DOS ALREADY CAPTURED (read-only, do not repeat):\n${input.existingTodos
            .map((todo) => `- ${todo}`)
            .join("\n")}`
        : "TO-DOS ALREADY CAPTURED: (none)",
    ].join("\n\n");

    const newCount = input.photos.filter((photo) => photo.isNew).length;

    return `${context}

${existing}

${input.photos.length} photo(s) total, listed in the order they were taken. ${newCount} are NEW:

${photoLines}

${this.partialNote(input, "the addition")}

LANGUAGE: write the ${asked} entirely in ${languageName}. The notes may be in
another language; translate them, keeping proper nouns, area and unit labels,
and any trade term you are unsure of exactly as written. Read-only text above
may be in a different language — do not translate or rewrite it, but write your
own output in ${languageName}.

Return only what the NEW photos add to the ${asked}.`;
  };

  // stage 1: notes -> structured facts
  private extractJobs = async (
    input: IDailyLogGenerateInput,
  ): Promise<IExtractedJob[]> => {
    const lines = this.inTimeOrder(input.photos)
      .map((photo, index) => {
        const description = photo.description?.trim();
        const tags = photo.tags?.filter(Boolean) ?? [];
        const parts = [
          `Photo ${index + 1}: ${description || "[no notes recorded]"}`,
        ];
        if (tags.length) parts.push(`  Tags: ${tags.join(", ")}`);
        return parts.join("\n");
      })
      .join("\n\n");

    const jobs = await baml.ExtractJobs(
      `${input.photos.length} photo(s), in the order they were taken:\n\n${lines}`,
      withTimeout(),
    );

    // BAML guarantees the shape and repairs a malformed response, so the
    // hand-written schema, JSON.parse and per-field String(x ?? "").trim() are
    // all gone. Only the empty-entry filter is still ours.
    return jobs.filter((job) => job.done || job.todo);
  };

  // ---- stage 2: the completed facts -> overview prose
  // Only the overview. The todos are written by stage 1 and pass through
  // untouched, so nothing downstream can re-word them into something wrong.
  private composeOverview = async (
    input: IDailyLogGenerateInput,
    jobs: IExtractedJob[],
    correction?: { missing?: string[]; wrongLanguage?: boolean },
  ): Promise<string> => {
    const done = jobs.filter((job) => job.done);
    if (!done.length) return "";
    const areas = Array.from(new Set(done.map((job) => job.area)));

    const factBlock = done
      .map((job, i) => `  ${i + 1}. [${job.area}] ${job.item} — ${job.done}`)
      .join("\n");

    const partialNote = this.partialNote(input, "the last entry");

    const retryNote = [
      correction?.wrongLanguage
        ? `\n\nYOUR PREVIOUS ATTEMPT WAS IN THE WRONG LANGUAGE. Write every word in ${
            DAILY_LOG_LANGUAGE_NAME[input.language]
          }.`
        : "",
      correction?.missing?.length
        ? `\n\nYOUR PREVIOUS ATTEMPT LEFT THESE OUT. They must appear this time:\n${correction.missing
            .map((m) => `  - ${m}`)
            .join("\n")}`
        : "",
    ].join("");

    const paragraphs = await baml.ComposeOverview(
      `${
        input.projectName ? `Project: ${input.projectName}\n` : ""
      }Date: ${input.date}

The notes have already been read. Below is the COMPLETED work, and it is the
only thing you write about — outstanding work is handled elsewhere and must not
appear here. Add nothing that is not listed.

${factBlock}

Write one entry per area, in this order: ${areas.join(", ")}. Each entry is
PROSE and opens by naming the area inside the sentence, like this:

  "In the bathroom, the extract fan was ducted through the external wall with
   the grille fitted outside, and the basin waste was connected and tested
   under load with no leaks."

Never use a label and a colon — "Bathroom: the extract fan was ducted" is
wrong. Area names are lower case as they read in a sentence, unless the name is
an identifier like "Bldg C" or "Unit 214". Each entry carries all of that
area's completed work with its specifics.

LANGUAGE: write everything in ${
        DAILY_LOG_LANGUAGE_NAME[input.language]
      }, keeping proper nouns, area and unit labels, and trade terms as written.

${partialNote}${retryNote}`,
      withTimeout(),
    );

    return paragraphs
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n");
  };

  private findMissing = (jobs: IExtractedJob[], overview: string): string[] => {
    const stem = (w: string) => w.replace(/(ings?|ed|es|s)$/, "").slice(0, 6);
    const key = (text: string) =>
      Array.from(
        new Set(
          text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 4)
            .map(stem),
        ),
      ).slice(0, 4);
    const inText = (words: string[], haystack: string) => {
      if (!words.length) return true;
      const hay = haystack.toLowerCase();
      return (
        words.filter((w) => hay.includes(w)).length >=
        Math.ceil(words.length / 2)
      );
    };

    return jobs
      .filter(
        (job) => job.done && !inText(key(`${job.item} ${job.done}`), overview),
      )
      .map((job) => `overview is missing: ${job.item} — ${job.done}`);
  };

  async generateDailyLog(
    input: IDailyLogGenerateInput,
  ): Promise<IDailyLogGenerateResult> {
    const mode: DailyLogGenerateMode = input.mode ?? "full";

    if (mode !== "append") {
      const jobs = await this.extractJobs(input);

      let overview = "";
      if (input.sections.includes("overview")) {
        overview = await this.composeOverview(input, jobs);

        if (looksWrongLanguage(overview, input.language)) {
          overview = await this.composeOverview(input, jobs, {
            wrongLanguage: true,
          });
        }

        // One correction pass: if the prose dropped a job, re-compose naming
        // what was missed. Not re-checked afterwards — a second miss is left
        // as-is rather than looping.
        const missing = this.findMissing(jobs, overview);
        if (missing.length) {
          overview = await this.composeOverview(input, jobs, { missing });
        }
      }

      const extractedTodos = jobs
        .map((job) => job.todo)
        .filter((todo): todo is string => !!todo);

      const result: IDailyLogGenerateResult = {};
      if (input.sections.includes("overview")) result.overview = overview;
      if (input.sections.includes("todos")) {
        const seen = new Set((input.existingTodos ?? []).map(normaliseTodo));
        result.todos = extractedTodos.filter((todo) => {
          const k = normaliseTodo(todo);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      return result;
    }

    const addition = await baml.AppendToLog(
      this.buildAppendPrompt(input),
      withTimeout(),
    );

    const result: IDailyLogGenerateResult = {};
    if (input.sections.includes("overview")) {
      result.overviewAddition = addition.overviewAddition.trim();
    }
    if (input.sections.includes("todos")) {
      const seen = new Set((input.existingTodos ?? []).map(normaliseTodo));
      result.todoAdditions = addition.todoAdditions
        .map((todo) => todo.trim())
        .filter(Boolean)
        .filter((todo) => {
          const k = normaliseTodo(todo);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
    }
    return result;
  }
}

export const dailyLogService = new DailyLogService();
