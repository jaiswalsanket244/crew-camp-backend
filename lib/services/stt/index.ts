import { ISTTService } from "../../utils/interfaces/walkthrough";
import { openAIWhisperSTTService } from "./openaiWhisper";

export const sttService: ISTTService = openAIWhisperSTTService;
