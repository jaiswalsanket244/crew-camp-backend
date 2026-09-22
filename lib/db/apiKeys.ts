import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
export interface IApiKey {
  keyId: string;
  keySecret: string;
  companyId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  lastUsed?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const ApiKeySchema = new mongoose.Schema(
  {
    keyId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    keySecret: {
      type: String,
      required: true,
    },
    companyId: {
      type: ObjectId,
      ref: "Companies",
      required: true,
      index: true,
    },
    userId: {
      type: ObjectId,
      ref: "Users",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastUsed: {
      type: Date,
    },
    expiresAt: {
      type: Date,
      index: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
    toObject: {
      virtuals: true,
    },
    toJSON: {
      virtuals: true,
    },
  },
);

ApiKeySchema.index({ keyId: 1, isActive: 1 });
ApiKeySchema.index({ companyId: 1, isActive: 1 });

export const ApiKey = mongoose.model<IApiKey>("ApiKey", ApiKeySchema);
