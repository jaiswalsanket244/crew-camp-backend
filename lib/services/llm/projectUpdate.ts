import { b as baml } from "../../baml_client";
import {
  IAiProjectUpdateGenerateInput,
  IAiProjectUpdateGenerateResult,
  IAiProjectUpdateLLMService,
} from "../../utils/interfaces/aiProjectUpdate";
import {
  GenerationDeadline,
  IDraft,
  IProgressFact,
  buildComposeRequest,
  cleanTitle,
  clampParagraphs,
  collectCorrections,
  dropForbiddenSentences,
  renderNotesByDay,
} from "./projectUpdatePrompt";

// Whole-request budget. The frontend aborts at 60 s, so this stays under it
// with room for the response to travel. See GenerationDeadline.
export const GENERATE_DEADLINE_MS = 50_000;

// The two BAML functions this service calls, as a structural type so tests can
// inject stubs without touching the generated client.
export interface IProjectUpdateClient {
  ExtractProgress(
    notes_by_day: string,
    options?: { signal?: AbortSignal },
  ): Promise<IProgressFact[]>;
  ComposeProjectUpdate(
    request: string,
    options?: { signal?: AbortSignal },
  ): Promise<IDraft>;
}

// Two stages, like the daily log, but with dated evidence in and
// status-over-time out:
//   1. ExtractProgress   notes grouped by day -> one fact per item, status from
//                        the latest evidence
//   2. ComposeProjectUpdate  facts -> title + 1-2 paragraphs
// Then deterministic guards. At most ONE stage-2 retry, carrying every
// correction at once, so a generation is never more than three model calls.
export class ProjectUpdateService implements IAiProjectUpdateLLMService {
  constructor(
    private readonly client: IProjectUpdateClient = baml as unknown as IProjectUpdateClient,
    private readonly budgetMs: number = GENERATE_DEADLINE_MS,
  ) {}

  async generateProjectUpdate(
    input: IAiProjectUpdateGenerateInput,
  ): Promise<IAiProjectUpdateGenerateResult> {
    const startedAt = Date.now();
    const deadline = new GenerationDeadline(this.budgetMs, startedAt);

    // ---- stage 1
    const facts = (
      await this.client.ExtractProgress(
        renderNotesByDay(input),
        deadline.callOptions(),
      )
    ).filter((fact) => fact.item?.trim() && fact.detail?.trim());

    if (!facts.length) {
      return { title: "", overview: "" };
    }

    // ---- stage 2 (+ at most one retry)
    let draft = await this.client.ComposeProjectUpdate(
      buildComposeRequest(input, facts),
      deadline.callOptions(),
    );
    const corrections = collectCorrections(draft, input.language);
    if (corrections.length) {
      draft = await this.client.ComposeProjectUpdate(
        buildComposeRequest(input, facts, corrections),
        deadline.callOptions(),
      );
    }

    // ---- deterministic fixes after the (single) retry
    const paragraphs = clampParagraphs(draft.paragraphs ?? [])
      .map(dropForbiddenSentences)
      .filter(Boolean);
    const title = dropForbiddenSentences(cleanTitle(draft.title ?? ""));
    const overview = paragraphs.join("\n\n");

    return { title, overview };
  }
}

export const projectUpdateService = new ProjectUpdateService();
