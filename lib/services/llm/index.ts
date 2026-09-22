import { ILLMService } from "../../utils/interfaces/walkthrough";
import { IDailyLogLLMService } from "../../utils/interfaces/dailyLog";
import { IAiProjectUpdateLLMService } from "../../utils/interfaces/aiProjectUpdate";
import { walkthroughReportService } from "./walkthroughReport";
import { dailyLogService } from "./dailyLog";
import { projectUpdateService } from "./projectUpdate";

// One export per LLM-backed feature. Both are typed to their interface
export const llmService: ILLMService = walkthroughReportService;
export const dailyLogLLMService: IDailyLogLLMService = dailyLogService;
export const aiProjectUpdateLLMService: IAiProjectUpdateLLMService =
  projectUpdateService;
