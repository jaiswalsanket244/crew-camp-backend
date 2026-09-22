// Marketing attribution captured from the signup payload. The frontend sends
// an `attribution` object; every field is optional. Kept source-agnostic so
// Google Ads / Apple Search Ads reuse the same shape later without rework.
export interface IAttribution {
  source?: string;
  click_id?: string;
  click_id_type?: string;
  campaign_id?: string;
  campaign_name?: string;
  landing_page_url?: string;
  referrer_url?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbp?: string;
  fbc?: string;
  attribution_captured_at?: Date;
}
