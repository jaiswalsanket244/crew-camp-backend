import OpenAI, { toFile } from "openai";
import { config } from "../../utils/configuration/config";
import { ISTTService } from "../../utils/interfaces/walkthrough";
import { ITranscriptSentence } from "../../utils/interfaces/walkthrough";

if (typeof globalThis.File === "undefined") {
  (globalThis as any).File = function File(
    chunks: BlobPart[],
    name: string,
    opts?: FilePropertyBag,
  ) {
    const blob = new Blob(chunks, opts);
    Object.defineProperty(blob, "name", { value: name, writable: false });
    Object.defineProperty(blob, "lastModified", {
      value: opts?.lastModified ?? Date.now(),
      writable: false,
    });
    return blob;
  };
}

class OpenAIWhisperSTTService implements ISTTService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  }

  async transcribe(audioBuffer: Buffer): Promise<ITranscriptSentence[]> {
    const file = await toFile(audioBuffer, "walkthrough.m4a", {
      type: "audio/m4a",
    });

    const transcription = await this.client.audio.transcriptions.create({
      file,
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    });

    const segments = (transcription as any).segments ?? [];

    return segments.map((seg: any) => ({
      text: seg.text.trim(),
      start: Math.round(seg.start * 1000),
      end: Math.round(seg.end * 1000),
    }));
  }
}

export const openAIWhisperSTTService = new OpenAIWhisperSTTService();
