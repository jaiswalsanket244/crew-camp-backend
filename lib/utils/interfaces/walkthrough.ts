export interface ITranscriptSentence {
  text: string;
  start: number;
  end: number;
}

export interface IWalkthroughPhoto {
  s3Url: string;
  timestamp: number;
  closestSentence?: string;
  surroundingContext?: string;
  burstLabel?: string;
}

export interface IAISubSection {
  subSectionName: string;
  description: string;
  photoIndex: number | null;
}

export interface IAISection {
  sectionName: string;
  sectionDescription: string;
  subSections: IAISubSection[];
}

export interface IWalkthroughReportSubSection {
  subSectionName: string;
  description: string;
  image?: string;
}

export interface IWalkthroughReportSection {
  sectionName: string;
  sectionDescription: string;
  subSections: IWalkthroughReportSubSection[];
}

export interface ISTTService {
  transcribe(audioBuffer: Buffer): Promise<ITranscriptSentence[]>;
}

export interface ILLMService {
  generateWalkthroughReport(
    transcript: string,
    photos: IWalkthroughPhoto[],
  ): Promise<IAISection[]>;
  expandClauses(clauses: string[]): Promise<string[]>;
  differentiatePhotoDescriptions(
    sharedSentence: string,
    surroundingContext: string,
    count: number,
  ): Promise<string[]>;
}

export interface BurstGroup {
  sentence: string;
  indices: number[];
}
