import * as express from "express";
import { TwilioMessageService } from "../../services/twilio";
import { SuccessResponse } from "../../utils/helpers/apiResponse";
import * as status from "http-status";
export class TwilioRoutes {
  public static send = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { number, message } = req.body;
      const messageService = new TwilioMessageService();

      if (!messageService.validE164(number)) {
        throw new Error("Number must be in E164 format.");
      }

      await messageService.sendMessages(number, message);

      return SuccessResponse(res, status.OK, { message: "Success." });
    } catch (error) {
      next(error);
    }
  };
}
