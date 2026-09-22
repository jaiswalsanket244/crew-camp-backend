import { ICoordinates } from "./location";
import { Types } from "mongoose";

/**
 * Gallery file entry stored in the database.
 */
export interface IGalleryFiles {
  _id: string;
  userId: string;
  postId: string;
  files: IGalleryFilesData[];
  galleryId: Types.ObjectId;
}

/**
 * Individual file data stored in a gallery.
 */
export interface IGalleryFilesData {
  url: string;
  fileType: string;
  uploadedAt: Date;
  location: ICoordinates;
}

/**
 * Expected request body for POST /api/gallery
 *
 * Each element represents a post containing files to share.
 * The _id field on files is required for validation but not stored.
 *
 * @example
 * [
 *   {
 *     "files": [
 *       {
 *         "_id": "507f1f77bcf86cd799439011",
 *         "url": "https://cdn.example.com/image.jpg",
 *         "fileType": "image",
 *         "uploadedAt": "2024-01-15T10:30:00.000Z",
 *         "location": { "long": -122.4194, "lat": 37.7749 }
 *       }
 *     ]
 *   }
 * ]
 *
 * Payload size: ~150 bytes/file. Max body size: 1MB (~5000 files).
 */
export type CreateGalleryRequestBody = Array<{
  files: Array<{
    _id: string;
    url: string;
    fileType: string;
    uploadedAt?: string;
    location?: ICoordinates;
  }>;
}>;
