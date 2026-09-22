import * as mongoose from "mongoose";

const ObjectId = mongoose.Schema.Types.ObjectId;

export interface IPendingUpload {
  companyId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  keyFile: string;
  url: string;
  fileType: string;
  sizeBytes?: number;
  uploadId?: string;
  claimedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One row per upload URL handed out by the external API.
 *
 * Presigning is the point where CrewCam commits storage it cannot yet see: the
 * caller may upload the bytes and never create the post, leaving an object that
 * nothing references and nothing ever bills back. Recording the key at
 * signing time lets the nightly reaper find exactly those, without scanning the
 * bucket or trying to prove a negative against every collection that stores a
 * url.
 *
 * Rows are written only for /v1 uploads. Internal app uploads are not tracked,
 * so the reaper can never touch a key it did not itself hand out.
 */
export const PendingUploadSchema = new mongoose.Schema(
  {
    companyId: {
      type: ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    userId: {
      type: ObjectId,
      ref: "User",
      required: true,
    },
    // S3 object key. Unique so a replayed presign cannot create duplicate rows
    // pointing at the same object.
    keyFile: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // The CDN url the caller was told to persist. Claim matching compares
    // against this as well as keyFile, since a caller may send either.
    url: {
      type: String,
      required: false,
    },
    fileType: {
      type: String,
      required: true,
    },
    sizeBytes: {
      type: Number,
      required: false,
    },
    // Set for multipart uploads so the reaper can abort ones never completed.
    uploadId: {
      type: String,
      required: false,
    },
    // Set once the object is referenced by a post, note or project. Claimed
    // rows are never reaped and are pruned on their own schedule.
    claimedAt: {
      type: Date,
      required: false,
    },
  },
  { timestamps: true, versionKey: false },
);

// Drives the reaper: unclaimed rows older than the grace period.
PendingUploadSchema.index({ claimedAt: 1, createdAt: 1 });

export const PendingUpload = mongoose.model<IPendingUpload>(
  "PendingUpload",
  PendingUploadSchema,
);
