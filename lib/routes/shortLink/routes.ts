import * as express from "express";
import { AuthenticatedRequest } from "../../utils/interfaces/authenticated-request";
import { ShortLinkHelpers } from "./helpers";
import { config } from "../../utils/configuration/config";

export class ShortLinkRoutes {
  public static getFullUrl = async (
    req: AuthenticatedRequest,
    res: express.Response,
  ) => {
    let url = `${config.APP_URL}`;
    try {
      const { id } = req.params;
      const result = await ShortLinkHelpers.getLink(id);
      if (result?.url) {
        url = result.url;
      }
      return res.redirect(url);
    } catch (error) {
      return res.redirect(url);
    }
  };
}
