import * as mongoose from "mongoose";
const ObjectId = mongoose.Schema.Types.ObjectId;

export const TodoListImagesSchema = new mongoose.Schema(
  {
    checklistId: {
      type: ObjectId,
      ref: "ProjectChecklist",
      required: true,
    },
    todoListId: {
      type: ObjectId,
      ref: "TodoList",
      required: true,
    },
    imageData: {
      url: { type: String, required: true },
      fileType: { type: String },
      uploadedAt: { type: Date },
      userId: {
        type: ObjectId,
        ref: "User",
        required: false,
      },
      size: {
        width: Number,
        height: Number,
      },
      location: {
        long: Number,
        lat: Number,
      },
      isPost: { type: Boolean, default: false },
    },
  },
  { timestamps: true, versionKey: false },
);
