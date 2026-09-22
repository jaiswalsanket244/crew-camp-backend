import { HttpClient } from "./httpClient";
import { config } from "../utils/configuration/config";
import { TurnstileVerifyResponse } from "../utils/interfaces/turnstile";

const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export class TurnstileService {
  /**
   * Validates a Turnstile token against Cloudflare's siteverify endpoint.
   * Fails closed: any missing config, network error, or malformed response
   * resolves to `false` so a bad/absent token never passes verification.
   */
  public static async verify(
    token: string,
    remoteIp?: string,
  ): Promise<boolean> {
    if (!config.TURNSTILE_SECRET_KEY || !token) {
      return false;
    }

    const result: TurnstileVerifyResponse = await HttpClient.Request({
      method: "POST",
      url: TURNSTILE_SITEVERIFY_URL,
      data: {
        secret: config.TURNSTILE_SECRET_KEY,
        response: token,
        ...(remoteIp ? { remoteip: remoteIp } : {}),
      },
    });

    return result?.success === true;
  }
}
