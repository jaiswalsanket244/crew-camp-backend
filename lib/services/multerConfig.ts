import * as multer from "multer";

const storage = multer.memoryStorage(); // recommended method
const size = 5 * 1024 * 1024;

// Filter the file types(only for image extensions).
const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  callback: multer.FileFilterCallback,
) => {
  if (
    file.mimetype.startsWith("image/") &&
    (file.originalname.endsWith(".jpg") ||
      file.originalname.endsWith(".jpeg") ||
      file.originalname.endsWith(".png"))
  ) {
    callback(null, true);
  } else {
    callback(new Error("Invalid file type. Only images are allowed."));
  }
};

export const upload = multer({
  storage: storage,
  limits: {
    fileSize: size,
  },
  fileFilter: fileFilter,
}).any();
