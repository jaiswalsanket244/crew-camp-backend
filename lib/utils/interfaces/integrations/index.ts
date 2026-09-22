import {
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUS,
} from "../../enums/integrations";
import { ObjectIdType } from "../schemaInterface";

// Core integration types
export * from "./types";

export * from "./companyCam";

export * from "./proline";

export interface IIntegration {
  _id: ObjectIdType;
  name: string;
  companyId: ObjectIdType;
  provider: INTEGRATION_PROVIDERS;
  credentials: {
    apiKey: string;
  };
  settings: {
    inboundSyncEnabled: boolean;
    outboundSyncEnabled: boolean;
  };
  webhookSecret: string;
  status: `${INTEGRATION_STATUS}`;
  lastSuccessfulSync: Date | null;
  lastError: {
    message: string;
    occurredAt: Date;
    code: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IntegrationProvider = INTEGRATION_PROVIDERS;
