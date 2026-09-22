import { httpClientConfig } from "../utils/interfaces/httpClientConfig";
import { HttpClient } from "./httpClient";
import { config } from "../utils/configuration/config";
import { firebaseService } from "./firebaseAdmin";

export default class SocialAuth {
  private accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private async sendHttpRequest(url: string, headers?: object) {
    const requestConfig: httpClientConfig = {
      method: "GET",
      url,
      headers,
    };
    return HttpClient.Request(requestConfig);
  }

  public async google() {
    return firebaseService.googleAuth(this.accessToken)
  }

  public async facebook() {
    const url = `${config.FACEBOOK_VERIFY_OAUTH_URL}?access_token=${this.accessToken}`;
    return this.sendHttpRequest(url);
  }

  public async microsoft() {
    const url = config.MICROSOFT_VERIFY_OAUTH_URL;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
    return this.sendHttpRequest(url, headers);
  }

  public apple(email: string, idToken: string) {
    const encodedStringArray = idToken.split(".");
    const decodedData = JSON.parse(atob(encodedStringArray[1]));

    if (
      decodedData.email !== email ||
      (decodedData.aud !== config.APPLE_CLIENT_ID &&
        decodedData.aud !== config.APPLE_CLIENT_ID_IOS)
    ) {
      return false;
    }

    return true;
  }
}
