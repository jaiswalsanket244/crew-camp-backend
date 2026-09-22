import * as sgMail from "@sendgrid/mail";
import { config } from "../utils/configuration/config";
import { ENV } from "../utils/enums/enums";
sgMail.setApiKey(config.SENDGRID_API_KEY);

export class SendGridService {
  public static readonly testEmail: string = config.SENDGRID_TEST_EMAIL;

  public static sendEmailWithHtml = async (params: {
    from: string;
    to: string;
    subject: string;
    html: string;
  }): Promise<boolean> => {
    try {
      if (config.NODE_ENV !== ENV.PRODUCTION) {
        params.to = this.testEmail;
      }

      await sgMail.send(params);
      return true;
    } catch (err) {
      return false;
    }
  };

  public static sendEmailWithText = async (params: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<boolean> => {
    try {
      if (config.NODE_ENV !== ENV.PRODUCTION) {
        params.to = this.testEmail;
      }

      await sgMail.send(params);
      return true;
    } catch (err) {
      return false;
    }
  };

  public static sendEmailWithTemplateId = async (params: {
    to: string;
    from: string;
    templateId: string;
    dynamic_template_data?: any;
  }): Promise<boolean> => {
    try {
      if (config.NODE_ENV !== ENV.PRODUCTION) {
        params.to = this.testEmail;
      }
      await sgMail.send(params);
      return true;
    } catch (err) {
      return false;
    }
  };
}
