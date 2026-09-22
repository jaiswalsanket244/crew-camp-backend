const { expect } = require("chai");
const { buildAttribution } = require("../../server/utils/helpers/attribution");

// Normalization of the `attribution` object posted with a signup request.
// Focus: the per-source click-attribution window. Meta's fbclid expires after
// 7 days, Google's gclid after ~90, so the lookback cannot be a single global
// timer. Runs against compiled output — no DB / env.
const daysAgo = (days) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

describe("buildAttribution (signup attribution normalization)", () => {
  describe("source inference", () => {
    it("infers google_ads from a gclid click id type", () => {
      const result = buildAttribution({
        click_id: "test_gclid",
        click_id_type: "gclid",
        attribution_captured_at: daysAgo(1),
      });
      expect(result.source).to.equal("google_ads");
      expect(result.click_id).to.equal("test_gclid");
    });

    it("infers meta from an fbclid click id type", () => {
      const result = buildAttribution({
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        attribution_captured_at: daysAgo(1),
      });
      expect(result.source).to.equal("meta");
    });

    it("falls back to meta for a click id sent without a type", () => {
      const result = buildAttribution({ click_id: "legacy_click" });
      expect(result.source).to.equal("meta");
    });

    it("defaults to organic when there is no source and no click id", () => {
      expect(buildAttribution({}).source).to.equal("organic");
      expect(buildAttribution(undefined).source).to.equal("organic");
    });

    it("keeps an explicitly supplied source", () => {
      const result = buildAttribution({
        source: "google_ads",
        click_id: "test_gclid",
        click_id_type: "gclid",
        attribution_captured_at: daysAgo(1),
      });
      expect(result.source).to.equal("google_ads");
    });
  });

  describe("per-source attribution window", () => {
    // The acceptance criterion: the same 30-day-old click attributes for
    // Google and expires for Meta.
    it("still attributes a gclid captured 30 days before signup", () => {
      const result = buildAttribution({
        source: "google_ads",
        click_id: "test_gclid",
        click_id_type: "gclid",
        attribution_captured_at: daysAgo(30),
      });
      expect(result.source).to.equal("google_ads");
      expect(result.click_id).to.equal("test_gclid");
      expect(result.click_id_type).to.equal("gclid");
    });

    it("expires an fbclid captured 30 days before signup", () => {
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        attribution_captured_at: daysAgo(30),
      });
      expect(result.source).to.equal("organic");
      expect(result.click_id).to.equal(undefined);
      expect(result.click_id_type).to.equal(undefined);
    });

    it("keeps an fbclid inside the 7-day Meta window", () => {
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        attribution_captured_at: daysAgo(3),
      });
      expect(result.source).to.equal("meta");
      expect(result.click_id).to.equal("test_fbclid");
    });

    it("expires a gclid past the 90-day Google window", () => {
      const result = buildAttribution({
        source: "google_ads",
        click_id: "test_gclid",
        click_id_type: "gclid",
        attribution_captured_at: daysAgo(100),
      });
      expect(result.source).to.equal("organic");
      expect(result.click_id).to.equal(undefined);
    });

    it("expires a click id inferred from its type, not just an explicit source", () => {
      const result = buildAttribution({
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        attribution_captured_at: daysAgo(30),
      });
      expect(result.source).to.equal("organic");
      expect(result.click_id).to.equal(undefined);
    });

    it("keeps a click id that has no capture timestamp to age it against", () => {
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
      });
      expect(result.source).to.equal("meta");
      expect(result.click_id).to.equal("test_fbclid");
    });
  });

  describe("raw facts kept when a click expires", () => {
    it("keeps UTMs, landing page, referrer, fbp and the capture time", () => {
      const capturedAt = daysAgo(30);
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        utm_source: "meta",
        utm_campaign: "test_campaign",
        landing_page_url: "https://crewcam.com/?fbclid=test_fbclid",
        referrer_url: "https://www.facebook.com/",
        fbp: "fb.1.123.456",
        attribution_captured_at: capturedAt,
      });
      expect(result.utm_source).to.equal("meta");
      expect(result.utm_campaign).to.equal("test_campaign");
      expect(result.landing_page_url).to.equal(
        "https://crewcam.com/?fbclid=test_fbclid",
      );
      expect(result.referrer_url).to.equal("https://www.facebook.com/");
      expect(result.fbp).to.equal("fb.1.123.456");
      expect(result.attribution_captured_at.toISOString()).to.equal(capturedAt);
    });

    // _fbc is fb.1.<timestamp>.<fbclid> — keeping it would keep the expired
    // click id under another name.
    it("drops fbc, which embeds the expired fbclid", () => {
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        fbc: "fb.1.123.test_fbclid",
        attribution_captured_at: daysAgo(30),
      });
      expect(result.fbc).to.equal(undefined);
    });

    it("keeps fbc for a click still inside its window", () => {
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        fbc: "fb.1.123.test_fbclid",
        attribution_captured_at: daysAgo(3),
      });
      expect(result.fbc).to.equal("fb.1.123.test_fbclid");
    });
  });

  describe("input hygiene", () => {
    it("ignores fields outside the whitelist", () => {
      const result = buildAttribution({
        source: "google_ads",
        isSuperAdmin: true,
        roles: ["SUPERADMIN"],
      });
      expect(result.isSuperAdmin).to.equal(undefined);
      expect(result.roles).to.equal(undefined);
    });

    it("trims values and drops blank strings", () => {
      const result = buildAttribution({
        click_id: "  test_gclid  ",
        click_id_type: "gclid",
        utm_source: "   ",
      });
      expect(result.click_id).to.equal("test_gclid");
      expect(result.utm_source).to.equal(undefined);
    });

    it("ignores an unparseable capture timestamp", () => {
      const result = buildAttribution({
        source: "meta",
        click_id: "test_fbclid",
        click_id_type: "fbclid",
        attribution_captured_at: "not-a-date",
      });
      expect(result.attribution_captured_at).to.equal(undefined);
      // Nothing to age it against, so the click id survives.
      expect(result.click_id).to.equal("test_fbclid");
    });
  });
});
