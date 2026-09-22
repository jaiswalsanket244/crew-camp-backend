import * as status from "http-status";
import * as express from "express";

import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { SuccessResponse } from "../../utils/helpers/apiResponse";
import { GalleryHelper } from "./helper";
import { config } from "../../utils/configuration/config";
import { ObjectId } from "../../utils/helpers/commonHelper";

export class GalleryRoutes {
  public static create = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const files = req.body.map((files) => {
        const filteredFiles = files.files.filter(
          (file) => file._id && file.url.startsWith("https://"),
        );
        return { files: filteredFiles };
      });
      const userId = req.user._id;
      const gallery = await GalleryHelper.createGallery(files, userId);
      return SuccessResponse(res, status.OK, {
        message: "gallery created successfully.",
        data: {
          url: config.WEB_URL + `/gallery/${gallery._id}`,
        },
      });
    } catch (error) {
      next(error);
    }
  };

  public static get = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const galleryId = req.params.id;

      const [gallery, creator] = await Promise.all([
        GalleryHelper.findFilesWithTheirData(ObjectId(galleryId)),
        GalleryHelper.getGalleryCreaterData(ObjectId(galleryId)),
      ]);

      const files = gallery.map((g) => {
        const fileData = { ...g.files, downloadUrl: g.files.url };
        if (fileData.downloadUrl.includes("cloudfront")) {
          const temp = fileData.url.split("/");
          temp[2] = `${config.S3_BUCKET_NAME}.s3.amazonaws.com`;
          fileData.downloadUrl = temp.join("/");
        }
        return {
          ...g,
          files: fileData,
        };
      });

      return SuccessResponse(res, status.OK, {
        data: {
          files,
          sharedBy: creator?.[0]?.userName,
          companyLogo: creator?.[0]?.companyLogo || "",
        },
      });
    } catch (error) {
      next(error);
    }
  };
}
