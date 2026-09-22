// NPM Dependencies
import * as express from "express";
import * as status from "http-status";
// Internal Dependencies
import { EmailService } from "../../services/email";
import { SuccessResponse } from "../../utils/helpers/apiResponse";

export class EmailRoutes {
  public static contactForm = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    try {
      const { name, email, message } = req.body;
      const emailService = new EmailService();
      await emailService.contactFormSubmission({ name, email, message });
      return SuccessResponse(res, status.OK, {
        message: "Mail sent successfully.",
      });
    } catch (error) {
      next(error);
    }
  };
}
