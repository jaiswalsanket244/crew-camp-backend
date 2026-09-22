import { openAIClient } from "./client";
import { ILLMService } from "../../utils/interfaces/walkthrough";
import {
  IAISection,
  IWalkthroughPhoto,
} from "../../utils/interfaces/walkthrough";

class WalkthroughReportService implements ILLMService {
  private client = openAIClient;

  async generateWalkthroughReport(
    transcript: string,
    photos: IWalkthroughPhoto[],
  ): Promise<IAISection[]> {
    const photoCount = photos.length;
    const photoList =
      photoCount > 0
        ? photos
            .map((p, i) => {
              const parts: string[] = [
                `Photo ${i} (captured at ${p.timestamp.toFixed(1)}s)`,
              ];
              if (p.burstLabel) {
                parts.push(`[burst ${p.burstLabel}]`);
              }
              if (p.closestSentence) {
                parts.push(`— closest speech: "${p.closestSentence}"`);
              } else {
                parts.push(`— NO SPEECH: leave description as empty string ""`);
              }
              if (p.surroundingContext) {
                parts.push(`| context: "${p.surroundingContext}"`);
              }
              return parts.join(" ");
            })
            .join("\n")
        : "No photos taken during this walkthrough.";

    const photoConstraint =
      photoCount > 0
        ? `IMPORTANT: There are exactly ${photoCount} photos (indices 0 to ${photoCount - 1}). Every index from 0 to ${photoCount - 1} MUST appear as the photoIndex of exactly one subSection. Do not skip any index. Do not use null.`
        : `There are no photos. Use null for all photoIndex values.`;

    const completion = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 4096,
      messages: [
        {
          role: "system",
          content: `You convert construction walkthrough transcripts into detailed reference reports for crew members and subcontractors.

The audience is the person who will DO the work — a crew member getting marching orders from a manager, or a sub getting scope from a GC. They need every specific detail: what to do, where, in what order, with what materials, and what to watch out for. If the speaker said it, it matters — include it.

Write as if you ARE the person who recorded the walkthrough, speaking directly to the crew. Not a narrator. Not a summary. The report IS the instructions.

Return ONLY a valid JSON array — no markdown, no explanation, no code fences.
Each element represents a report section with this exact structure:
[
  {
    "sectionName": "string",
    "sectionDescription": "A detailed description that captures the key specifics for this section — what areas, what scope, what the crew needs to know at a glance",
    "subSections": [
      {
        "subSectionName": "string",
        "description": "The full detail of what the speaker said — specific locations, materials, steps, sequences, measurements, warnings, and callouts extracted from the transcript",
        "photoIndex": number | null
      }
    ]
  }
]
photoIndex must be a valid 0-based index from the provided photos list, or null if no photos exist.`,
        },
        {
          role: "user",
          content: `Transcript of site walkthrough:
"""
${transcript}
"""

Photos available (by index and timestamp from recording start):
${photoList}

${photoConstraint}

Generate a construction site walkthrough report from the transcript above.
Group content into logical sections (e.g. Overview, Site Conditions, Safety Observations, Action Items).

WRITING RULES — these override all other style guidance:

Your reader is a crew member or subcontractor who was NOT on this walkthrough. This report is their only reference. Every specific detail you drop is something they'll have to call and ask about or guess wrong on.

1. EXTRACT, DON'T SUMMARIZE. Write the actual content from the transcript — not a description of what was said.
   BAD: "Instructions for dishwasher removal"
   GOOD: "Turn off the water supply valve under the sink, disconnect the water line, then pull the dishwasher out"
   BAD: "Steps to address the roof damage"
   GOOD: "Strip the old shingles on the south-facing slope, check the decking for rot — especially near the chimney flashing — and re-paper before laying new shingles"
   BAD: "Emphasis on protecting the flooring"
   GOOD: "Lay down ram board on all hardwood floors before bringing materials through the front entry"
   BAD: "Discussion of timeline and scheduling"
   GOOD: "Demo needs to be done by Thursday. Dumpster is coming Friday morning so have everything torn out and staged in the garage by end of day Thursday"

2. PRESERVE EVERY DETAIL. Locations, room names, materials, brands, measurements, sequences, tool callouts, warnings, timelines, and conditions — if the speaker mentioned it, include it. These are the details the crew will reference on site.

3. NEVER use meta-language. Never write "instructions to do X" — write the actual instructions. Never write "steps to remove Y" — write the actual steps. Never write "emphasis on Z" — state the concern directly. Never write "details about X" — write the details.

4. MATCH THE SPEAKER'S VOICE. The transcript's tone and formality are the source of truth. Carry that voice through naturally — don't flatten it into generic report-speak.

5. SECTION DESCRIPTIONS MATTER. The sectionDescription should give a useful overview of what's covered — specific areas, scope items, or key takeaways — not a generic label like "overview of site conditions."

Photo assignment rules:
- Photos are listed in chronological capture order (Photo 0 was taken first).
- Each photo shows the timestamp when it was captured, the closest speech, and optionally surrounding context and burst info.
- Use the "closest speech" and surrounding context to identify the topic of each photo and assign it to the matching subSection.
- Photos marked with "[burst X of Y]" were taken in rapid succession. Each burst photo MUST get its own subSection with a UNIQUE description — never copy the same description across burst photos. Use the unique closest-speech hint provided for each photo; if hints differ, use them directly.
- If a photo is marked "NO SPEECH", place it in the most contextually relevant section and set its description to exactly "" (empty string).
- CRITICAL: Every subSection description MUST be unique across the entire report. No two subSections may have identical description text.
- Every photoIndex from 0 to ${photoCount - 1} must appear in exactly one subSection.`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "";
    const sections = JSON.parse(content) as IAISection[];

    if (photoCount > 0) {
      const assigned = new Set<number>();
      for (const section of sections) {
        for (const sub of section.subSections) {
          if (sub.photoIndex != null) assigned.add(sub.photoIndex);
        }
      }
      const unassigned: number[] = [];
      for (let i = 0; i < photoCount; i++) {
        if (!assigned.has(i)) unassigned.push(i);
      }

      for (const idx of unassigned) {
        let done = false;
        for (const section of sections) {
          for (const sub of section.subSections) {
            if (sub.photoIndex == null) {
              (sub as any).photoIndex = idx;
              done = true;
              break;
            }
          }
          if (done) break;
        }
        if (!done && sections.length > 0) {
          const lastSection = sections[sections.length - 1];
          lastSection.subSections.push({
            subSectionName: `Photo ${idx + 1}`,
            description: "",
            photoIndex: idx,
          });
        }
      }
    }
    console.log("sections", sections);
    return sections;
  }

  async differentiatePhotoDescriptions(
    sharedSentence: string,
    surroundingContext: string,
    count: number,
  ): Promise<string[]> {
    const completion = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 2000,
      messages: [
        {
          role: "system",
          content: `You help create unique photo captions for construction walkthrough reports.

You are given:
- A sentence that was spoken while multiple photos were taken in rapid succession
- Surrounding transcript context (sentences spoken before and after)
- The number of photos that need unique descriptions

Your job: produce exactly ${count} short, unique descriptions — one per photo.
The photos were captured sequentially during/around the shared sentence.

WRITING RULES — these override all other style guidance:

Write as if you ARE the person who recorded the walkthrough, speaking directly to the crew. Not a narrator. Not a summary. The report IS the instructions.

Your reader is a crew member or subcontractor who was NOT on this walkthrough. This report is their only reference. Every specific detail you drop is something they'll have to call and ask about or guess wrong on.

EXTRACT, DON'T SUMMARIZE. Write what the speaker actually said — not a description of what was said.
BAD: "Overview of kitchen demolition area"
GOOD: "Pull the dishwasher out after turning off the water supply valve under the sink"
BAD: "Continuation of roof inspection"
GOOD: "Check the decking for rot near the chimney flashing before re-papering"

1. NEVER use meta-language. Never write "instructions to do X" — write the actual instructions. Never write "steps to remove Y" — write the actual steps. Never write "emphasis on Z" — state the concern directly. Never write "details about X" — write the details.

2. MATCH THE SPEAKER'S VOICE. The transcript's tone and formality are the source of truth. Carry that voice through naturally — don't flatten it into generic report-speak.

Rules:
1. Each description must be meaningfully different — not just reworded copies.
2. Use the surrounding context to infer what different aspects each sequential photo might show.
3. If context is insufficient for truly unique descriptions, use sequential framing:
   - First photo: introduce the subject/area
   - Middle photos: progressive detail or different angles
   - Last photo: concluding view or wider context
4. Keep each description under 30 words.
5. Return ONLY a valid JSON array of ${count} strings — no markdown, no explanation.`,
        },
        {
          role: "user",
          content: `Shared sentence: "${sharedSentence}"

Surrounding transcript context:
"""
${surroundingContext || "(no surrounding context available)"}
"""

Generate ${count} unique photo descriptions.`,
        },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "[]";
    try {
      const descriptions = JSON.parse(content) as string[];
      if (descriptions.length === count) return descriptions;
    } catch {
      // fall through to fallback
    }
    // Fallback: number them
    return Array.from(
      { length: count },
      (_, i) => `${sharedSentence} (view ${i + 1} of ${count})`,
    );
  }

  async expandClauses(clauses: string[]): Promise<string[]> {
    const completion = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `You expand short construction observation phrases into clear, descriptive sentences that preserve all specific details (locations, materials, measurements, sequences).
Return ONLY a valid JSON array of strings — no markdown, no explanation.
Each input phrase becomes one expanded string. Keep the same order. Do not add information not implied by the phrase.

Write as if you ARE the person who recorded the walkthrough, speaking directly to the crew. Not a narrator. Not a summary. The report IS the instructions.

WRITING RULES — these override all other style guidance:

Write as if you ARE the person who recorded the walkthrough, speaking directly to the crew. Not a narrator. Not a summary. The report IS the instructions.

EXTRACT, DON'T SUMMARIZE. Write the actual content — not a description of it.
BAD: "Instructions for dishwasher removal"
GOOD: "Turn off the water supply valve under the sink, disconnect the water line, then pull the dishwasher out"
BAD: "Details about flooring protection"
GOOD: "Lay down ram board on all hardwood floors before bringing materials through the front entry"

1. NEVER use meta-language. Never write "instructions to do X" — write the actual instructions. Never write "steps to remove Y" — write the actual steps. Never write "emphasis on Z" — state the concern directly. Never write "details about X" — write the details.

2. MATCH THE SPEAKER'S VOICE. The transcript's tone and formality are the source of truth. Carry that voice through naturally — don't flatten it into generic report-speak.

Do not generalize or abstract — keep the concrete details from the original phrase.`,
        },
        {
          role: "user",
          content: JSON.stringify(clauses),
        },
      ],
    });
    const content = completion.choices[0]?.message?.content ?? "[]";
    const expanded = JSON.parse(content) as string[];
    return expanded.length === clauses.length ? expanded : clauses;
  }
}

export const walkthroughReportService = new WalkthroughReportService();
