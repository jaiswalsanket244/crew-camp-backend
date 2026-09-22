import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const RevenueCatLogsSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      ref: "User",
    },
    event: {},
    product_id: {
      type: String
    },
    price: {
      type: String
    },
    time: {
      type: String
    },
    type: {
      type: String
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);
