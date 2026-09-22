import * as multer from "multer";
import { ALLOWED_AUDIO_MIME_TYPES, AUDIO_SIZE_LIMIT } from "../constants/audio";

const audioFileFilter = (
  _req: Express.Request,
  file: Express.Multer.File,
  callback: multer.FileFilterCallback,
) => {
  if (ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype)) {
    callback(null, true);
  } else {
    callback(new Error(`Unsupported audio type: ${file.mimetype}`));
  }
};

export const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AUDIO_SIZE_LIMIT },
  fileFilter: audioFileFilter,
}).single("audio");
