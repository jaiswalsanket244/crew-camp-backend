import * as mongoose from "mongoose";
export const UrlsSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

UrlsSchema.pre("save", function (next): void {
  if (this.url) {
    this.url = this.url.trim();
  }
  next();
});

UrlsSchema.index({ url: 1 }, { unique: true });
