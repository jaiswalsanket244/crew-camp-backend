import { ProjectHelper } from "../projects/helper";
import { ProjectReportsHelpers } from "../projectReport/helpers";
import { sttService } from "../../services/stt";
import { llmService } from "../../services/llm";
import {
  IWalkthroughPhoto,
  ITranscriptSentence,
  IAISection,
  BurstGroup,
} from "../../utils/interfaces/walkthrough";
import { IReportSectionInput } from "../../utils/interfaces/projectReports";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { REPORT_SOURCE } from "../../utils/enums/projectReports";

const MAX_AFTER_SEC = 15;
const CLAUSE_SPLIT_RE = /\s*(?:,|;)\s*|\s+(?:and|or)\s+/i;

const CONTEXT_WINDOW_SEC = 10;

function findDescribingSentence(
  sentences: ITranscriptSentence[],
  photoTimestampSec: number,
): ITranscriptSentence | null {
  let bestDuring: ITranscriptSentence | null = null;
  let bestDuringDist = Infinity;
  let firstAfter: ITranscriptSentence | null = null;
  let firstAfterDist = Infinity;
  let nearestBefore: ITranscriptSentence | null = null;
  let nearestBeforeDist = Infinity;

  for (const s of sentences) {
    const startSec = s.start / 1000;
    const endSec = s.end / 1000;
    const midSec = (startSec + endSec) / 2;

    if (startSec <= photoTimestampSec && photoTimestampSec <= endSec) {
      const dist = Math.abs(photoTimestampSec - midSec);
      if (dist < bestDuringDist) {
        bestDuringDist = dist;
        bestDuring = s;
      }
    } else if (startSec > photoTimestampSec) {
      const dist = startSec - photoTimestampSec;
      if (dist < firstAfterDist) {
        firstAfterDist = dist;
        firstAfter = s;
      }
    } else {
      const dist = photoTimestampSec - endSec;
      if (dist < nearestBeforeDist) {
        nearestBeforeDist = dist;
        nearestBefore = s;
      }
    }
  }

  if (bestDuring) return bestDuring;
  if (firstAfter && firstAfterDist <= MAX_AFTER_SEC) return firstAfter;
  if (firstAfter && nearestBefore) {
    return firstAfterDist <= nearestBeforeDist ? firstAfter : nearestBefore;
  }
  return firstAfter ?? nearestBefore ?? null;
}

function buildSurroundingContext(
  sentences: ITranscriptSentence[],
  photoTimestampSec: number,
): string {
  const windowStart = photoTimestampSec - CONTEXT_WINDOW_SEC;
  const windowEnd = photoTimestampSec + CONTEXT_WINDOW_SEC;

  const nearby = sentences.filter((s) => {
    const startSec = s.start / 1000;
    const endSec = s.end / 1000;
    return endSec >= windowStart && startSec <= windowEnd;
  });

  if (nearby.length === 0) return "";
  return nearby
    .map((s) => `[${(s.start / 1000).toFixed(1)}s] ${s.text}`)
    .join(" | ");
}

function detectSharedSentenceBursts(photos: IWalkthroughPhoto[]): BurstGroup[] {
  const groups = new Map<string, number[]>();
  photos.forEach((p, i) => {
    if (!p.closestSentence) return;
    const arr = groups.get(p.closestSentence) ?? [];
    arr.push(i);
    groups.set(p.closestSentence, arr);
  });

  const bursts: BurstGroup[] = [];
  for (const [sentence, indices] of Array.from(groups.entries())) {
    if (indices.length <= 1) continue;
    bursts.push({ sentence, indices });
  }
  return bursts;
}

async function differentiateSharedPhotos(
  photos: IWalkthroughPhoto[],
): Promise<void> {
  const bursts = detectSharedSentenceBursts(photos);
  if (bursts.length === 0) return;

  for (const burst of bursts) {
    const { sentence, indices } = burst;
    const N = indices.length;

    indices.forEach((idx, pos) => {
      photos[idx].burstLabel = `${pos + 1} of ${N}`;
    });

    const match = sentence.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (!match) continue;
    const [, timestamp, rawText] = match;

    const clauses = rawText
      .split(CLAUSE_SPLIT_RE)
      .map((c: string) => c.trim())
      .filter(Boolean);

    if (clauses.length >= N) {
      const assigned =
        clauses.length === N
          ? clauses
          : clauses.slice(0, N - 1).concat(clauses.slice(N - 1).join(", "));
      const toExpand = Array.isArray(assigned) ? assigned : [assigned];
      const expanded = await llmService.expandClauses(
        toExpand.length === N ? toExpand : clauses.slice(0, N),
      );
      if (expanded.length === N) {
        for (let i = 0; i < N; i++) {
          photos[indices[i]].closestSentence = `[${timestamp}] ${expanded[i]}`;
        }
        continue;
      }
    }

    const surroundingCtx = photos[indices[0]].surroundingContext ?? "";
    const descriptions = await llmService.differentiatePhotoDescriptions(
      rawText,
      surroundingCtx,
      N,
    );
    if (descriptions.length === N) {
      for (let i = 0; i < N; i++) {
        photos[indices[i]].closestSentence =
          `[${timestamp}] ${descriptions[i]}`;
      }
      continue;
    }

    for (let i = 0; i < N; i++) {
      photos[indices[i]].closestSentence =
        `[${timestamp}] ${rawText} (view ${i + 1} of ${N})`;
    }
  }
}

function buildPhotoPayload(
  sentences: ITranscriptSentence[],
  photos: { timestamp: number }[],
): IWalkthroughPhoto[] {
  return photos.map((p) => {
    const closest =
      sentences.length > 0
        ? findDescribingSentence(sentences, p.timestamp)
        : null;

    const surroundingContext =
      sentences.length > 0
        ? buildSurroundingContext(sentences, p.timestamp)
        : undefined;

    return {
      s3Url: "",
      timestamp: p.timestamp,
      closestSentence: closest
        ? `[${(closest.start / 1000).toFixed(1)}s] ${closest.text}`
        : undefined,
      surroundingContext: surroundingContext || undefined,
    };
  });
}

export class WalkthroughHelpers {
  static buildPhotosOnlyReport(photos: { timestamp: number }[]): IAISection[] {
    if (!photos.length) return [];
    return [
      {
        sectionName: "Photos",
        sectionDescription: "",
        subSections: photos.map((_, i) => ({
          subSectionName: `Photo ${i + 1}`,
          description: "",
          photoIndex: i,
        })),
      },
    ];
  }

  static async generateReport(
    sentences: ITranscriptSentence[],
    photos: { timestamp: number }[],
  ): Promise<IAISection[]> {
    if (!sentences.length) return this.buildPhotosOnlyReport(photos);

    const transcript = sentences
      .map((s) => `[${(s.start / 1000).toFixed(1)}s] ${s.text}`)
      .join("\n");

    const photoPayload = buildPhotoPayload(sentences, photos);
    await differentiateSharedPhotos(photoPayload);
    return llmService.generateWalkthroughReport(transcript, photoPayload);
  }

  static async saveGeneratedReport(params: {
    sections: IAISection[];
    photos: { timestamp: number; url?: string }[];
    projectId: string;
    reportName: string;
    companyId: ObjectIdType;
    userId: ObjectIdType;
  }): Promise<{ reportId: string }> {
    const sections: IReportSectionInput[] = params.sections.map((section) => ({
      sectionName: section.sectionName,
      sectionDescription: section.sectionDescription,
      subSections: section.subSections.map((sub) => {
        const url =
          sub.photoIndex !== null && sub.photoIndex !== undefined
            ? params.photos[sub.photoIndex]?.url
            : undefined;
        return {
          subSectionName: sub.subSectionName,
          description: sub.description,
          ...(url ? { image: url } : {}),
        };
      }),
    }));

    const report = await ProjectReportsHelpers.createReport({
      companyId: params.companyId,
      projectId: params.projectId as unknown as ObjectIdType,
      userId: params.userId,
      reportName: params.reportName,
      photosPerPage: 0,
      showCoverPage: false,
      showCoverPageImage: false,
      coverPageImage: "",
      showCompanyName: false,
      showCreatedBy: false,
      showCreatedAt: false,
      showPageCount: false,
      reportSource: REPORT_SOURCE.AI,
    });

    await ProjectReportsHelpers.createSectionsWithSubSections(
      report._id,
      params.userId,
      sections,
    );

    ProjectHelper.updateProjectInfo(report.projectId);

    return { reportId: String(report._id) };
  }

  static async processAndGenerate(
    audioBuffer: Buffer,
    photos: { timestamp: number }[],
  ): Promise<IAISection[]> {
    const sentences = await sttService.transcribe(audioBuffer);
    if (!sentences.length) return this.buildPhotosOnlyReport(photos);

    const transcript = sentences
      .map((s) => `[${(s.start / 1000).toFixed(1)}s] ${s.text}`)
      .join("\n");

    const photoPayload = buildPhotoPayload(sentences, photos);
    await differentiateSharedPhotos(photoPayload);
    return llmService.generateWalkthroughReport(transcript, photoPayload);
  }
}
