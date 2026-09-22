import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;
export const FcmTokensSchema = new mongoose.Schema({
  userId: {
    type: ObjectId,
    required: true,
    ref: "User",
  },
  token: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
  versionKey: false,
});
