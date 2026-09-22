import { config } from "../utils/configuration/config";
import { CONTACT_US_URL } from "../utils/constants/constants";
import { SendGridService } from "./sendgrid";
export class EmailService {
  private readonly sendgridUserEmail: string = config.SENDGRID_USER_EMAIL;
  private readonly sendgridTemplateID: string;

  public contactFormSubmission = ({ name, email, message }) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: this.sendgridUserEmail,
      subject: `${name} Contact Form Submission`,
      text: `
          Name: ${name},
          Email: ${email},
          Message: ${message}
          `,
    });
  };

  public sendPWResetEmail = async (body: { email: string; token: string }) => {
    const resetUrl = `${process.env.FRONTEND_HOST}/reset-password?email=${body.email}&token=${body.token}`;
    return SendGridService.sendEmailWithHtml({
      from: this.sendgridUserEmail,
      to: body.email,
      subject: "Reset Password",
      html: `<p>Click <a href='http://${resetUrl}'>here</a>
          to reset your password</p>`,
    });
  };

  public sendEmail = async ({ subject, email, data }) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: email,
      subject: subject,
      text: data,
    });
  };

  public sendgridTemplate = async (data, email, sendgridTemplateID) => {
    return SendGridService.sendEmailWithTemplateId({
      from: `${this.sendgridUserEmail}`,
      to: email,
      templateId: sendgridTemplateID,
      dynamic_template_data: data,
    });
  };

  public newSubscriptionEmail = (userDetails) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: userDetails.email,
      subject: ` Welcome`,
      text: `
          Hey ${userDetails.fullName},
          Thanks for joining.
          `,
    });
  };

  public subscriptionRenewalSuccessEmail = (userDetails) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: userDetails.email,
      subject: `${userDetails.fullName} renewal Success`,
      text: `
          Hey ${userDetails.fullName},
          Your  subscription is renewed.
          `,
    });
  };

  public subscriptionRenewalFailedEmail = (userDetails) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: userDetails.email,
      subject: `${userDetails.fullName} Welcome`,
      text: `
          Hey ${userDetails.fullName},
          We were not able to renew your subscription. Please manually renew it.
          `,
    });
  };

  public subscriptionPaymentFailedEmail = (userDetails) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: userDetails.email,
      subject: `${userDetails.fullName} Welcome`,
      text: `
          Hey ${userDetails.fullName},
          Your payment has been failed. we will not be able to proceed with your subscription.
          `,
    });
  };

  public sendCancellationEmail = (userDetails) => {
    return SendGridService.sendEmailWithText({
      from: this.sendgridUserEmail,
      to: userDetails.email,
      subject: `${userDetails.fullName}  Subscription cancelled!`,
      text: `
          Hey ${userDetails.fullName},
          We have successfully cancelled you renewal .
          `,
    });
  };

  public inviteUserEmail = (details: { email: string; link: string }) => {
    return SendGridService.sendEmailWithHtml({
      from: this.sendgridUserEmail,
      to: details.email,
      subject: `${details.email} Welcome`,
      html: `
          <p>Hey ${details.email},</p>
          <p>You've been invited to sign up on Byldd's boilerplate.</p>
          <p>Please click <a href="${details.link}"">here</a></p>
          `,
    });
  };

  public refundEmail = (details: {
    email: string;
    amount: number;
    currency: string;
    status: string;
  }) => {
    return SendGridService.sendEmailWithHtml({
      from: this.sendgridUserEmail,
      to: details.email,
      subject: `Refund`,
      html: `
          <p>Hey ${details.email},</p>
          <p>Refund of amount ${details.currency} ${details.amount} has been initiated with the status of ${details.status}.</p>
          `,
    });
  };

  public sendOtpMail = (userDetails: { email: string; otp: string }) => {
    return SendGridService.sendEmailWithTemplateId({
      from: this.sendgridUserEmail,
      to: userDetails.email,
      templateId: "d-56bcf6f07f6b42bd8354f7f2722dc97d",
      dynamic_template_data: {
        otp: userDetails.otp.split(""),
      },
    });
  };

  private escapeHtml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  // Sent to the user's OLD email after a successful email/phone change so they
  // can react if the change wasn't theirs. newValue is user-supplied, so it is
  // HTML-escaped to prevent link/markup injection into this alert.
  public sendContactChangedEmail = (details: {
    email: string;
    changedField: string;
    newValue: string;
  }) => {
    return SendGridService.sendEmailWithHtml({
      from: this.sendgridUserEmail,
      to: details.email,
      subject: "Your CrewCam login was changed",
      html: `
          <p>Your CrewCam login ${this.escapeHtml(details.changedField)} was just changed to ${this.escapeHtml(details.newValue)}.</p>
          <p>If you did not make this change, please <a href="${CONTACT_US_URL}">contact us</a> immediately: ${CONTACT_US_URL}</p>
          `,
    });
  };

  public sharePaymentLink = (details: { email: string; link: string }) => {
    return SendGridService.sendEmailWithHtml({
      from: this.sendgridUserEmail,
      to: details.email,
      subject: `${details.email} Subscription Payment link`,
      html: `
          <p>Hey ${details.email},</p>
          <p>Your payment link for subscription is attached below</p>
          <p>Please click <a href="${details.link}"">here</a></p>
          `,
    });
  };
}
