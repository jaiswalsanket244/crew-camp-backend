// Response shape returned by Cloudflare Turnstile's siteverify endpoint.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
export interface TurnstileVerifyResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}
