import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
import {
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUS,
} from "../utils/enums/integrations";

export interface IIntegration {
  _id: mongoose.Types.ObjectId;
  name: string;
  companyId: mongoose.Types.ObjectId;
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

export const IntegrationSchema = new mongoose.Schema<IIntegration>(
  {
    name: {
      type: String,
      required: true,
    },
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
    },
    provider: {
      type: String,
      enum: INTEGRATION_PROVIDERS,
      required: true,
    },
    credentials: {
      apiKey: { type: String, required: true },
    },
    settings: {
      inboundSyncEnabled: { type: Boolean, default: true },
      outboundSyncEnabled: { type: Boolean, default: true },
    },
    webhookSecret: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: INTEGRATION_STATUS,
      default: "disconnected",
    },
    lastSuccessfulSync: { type: Date, default: null },
    lastError: {
      message: { type: String },
      occurredAt: { type: Date },
      code: { type: String },
    },
  },
  { timestamps: true },
);

// One integration per provider per workspace
IntegrationSchema.index({ companyId: 1, provider: 1 }, { unique: true });
