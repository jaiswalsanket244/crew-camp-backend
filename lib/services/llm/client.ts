import OpenAI from "openai";
import { config } from "../../utils/configuration/config";

// Single shared client for every LLM-backed feature.
export const openAIClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
