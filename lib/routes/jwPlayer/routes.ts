// NPM Dependencies
import * as status from "http-status";
import * as express from "express";
import * as JWPlatformAPI from "jwplatform";

// Internal Dependencies
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { config } from "../../utils/configuration/config";
import { SuccessResponse } from "../../utils/helpers/apiResponse";
import { HttpClient } from "../../services/httpClient";
import { httpClientConfig } from "../../utils/interfaces/httpClientConfig";

const jwApiInstance = new JWPlatformAPI({
  apiKey: config.JW_API_KEY,
  apiSecret: config.JW_API_SECRET,
});

export class JWPlayerRoutes {
  public static createJwURl = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { videoUrl } = req.body.document;
      const date: number = Math.floor(Date.now() / 1000);
      const jwInstance = await jwApiInstance.videos.create({
        download_url: videoUrl,
        title: "Sample",
        tags: "video",
        date,
      });
      const jwUrl = `https://cdn.jwplayer.com/v2/media/${jwInstance.video.key}`;
      return SuccessResponse(res, status.OK, {
        message: "Success.",
        data: { jwUrl, mediaId: jwInstance.video.key },
      });
    } catch (error) {
      next(error);
    }
  };

  public static getJWPlayerVideoUrls = async (
    req: AuthenticatedRequest,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { jwUrl } = req.body;
      const requestConfig: httpClientConfig = {
        method: "GET",
        url: jwUrl,
      };
      const data = await HttpClient.Request(requestConfig);
      return SuccessResponse(res, status.OK, { message: "Success.", data });
    } catch (error) {
      next(error);
    }
  };
}
