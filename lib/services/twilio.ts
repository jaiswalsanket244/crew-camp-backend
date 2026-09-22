import Twilio = require("twilio");
import { config } from "../utils/configuration/config";

export class TwilioMessageService {
  client: any;
  private twilioNumber: string = config.TWILIO_NUMBER;
  private accountSid: string = config.TWILIO_ACCOUNTSID;
  private authToken: string = config.TWILIO_AUTHTOKEN;
  private verifyServiceSid: string = config.TWILIO_VERIFY_SERVICE_SID;
  constructor() {
    this.client = Twilio(this.accountSid, this.authToken);
  }

  public sendMessages = (number: string, message: string) => {
    const textContent = {
      body: `Your CrewCam verification code is ${message}`,
      to: number,
      from: this.twilioNumber,
    };

    return this.client.messages.create(textContent).then((res) => res);
  };
  // Sends the body as-is (no "verification code" wrapper). Used for account
  // alerts such as notifying the old number after a phone change.
  public sendPlainMessage = (number: string, body: string) => {
    const textContent = {
      body,
      to: number,
      from: this.twilioNumber,
    };

    return this.client.messages.create(textContent).then((res) => res);
  };

  // Validate E164 format
  public validE164 = (num: string) => {
    return /^\+?[1-9]\d{1,14}$/.test(num);
  };

  public sendOtp = (phoneE164: string) => {
    return this.client.verify.v2
      .services(this.verifyServiceSid)
      .verifications.create({ to: phoneE164, channel: "sms" });
  };

  public verifyOtp(phoneE164: string, code: string) {
    return this.client.verify.v2
      .services(this.verifyServiceSid)
      .verificationChecks.create({ to: phoneE164, code });
  }
}
