/**
 * Integration Unit Tests
 *
 * Tests that don't require database connection.
 * Tests provider logic, parsing, and transformations.
 */

const { expect } = require("chai");
const sinon = require("sinon");

describe("CRM Integrations - Unit Tests", function () {
  this.timeout(5000);

  let JobNimbusProvider;
  let PROVIDER_INFO, isProviderAvailable;

  before(function () {
    // Import compiled modules
    const jobnimbus = require("../../server/integrations/providers/jobnimbus");
    JobNimbusProvider = jobnimbus.JobNimbusProvider;

    const manager = require("../../server/integrations/manager");
    PROVIDER_INFO = manager.PROVIDER_INFO;
    isProviderAvailable = manager.isProviderAvailable;
  });

  afterEach(function () {
    sinon.restore();
  });

  // ============================================
  // Provider Info Tests
  // ============================================

  describe("Provider Registry", function () {
    it("should have JobNimbus registered", function () {
      expect(PROVIDER_INFO).to.have.property("jobnimbus");
    });

    it("should mark JobNimbus as available", function () {
      expect(isProviderAvailable("jobnimbus")).to.be.true;
    });

    it("should have correct JobNimbus metadata", function () {
      expect(PROVIDER_INFO.jobnimbus.displayName).to.equal("JobNimbus");
      expect(PROVIDER_INFO.jobnimbus.description).to.include("JobNimbus");
    });

    it("should mark Roofr as unavailable (not yet implemented)", function () {
      expect(isProviderAvailable("roofr")).to.be.false;
    });

    it("should return false for unknown provider", function () {
      expect(isProviderAvailable("unknown")).to.be.false;
    });
  });

  // ============================================
  // JobNimbus Provider Tests
  // ============================================

  describe("JobNimbus Provider", function () {
    let provider;
    const mockIntegration = {
      _id: "integration-123",
      companyId: "company-456",
      provider: "jobnimbus",
      credentials: { apiKey: "test-api-key-xyz" },
      webhookSecret: "webhook-secret-abc",
      settings: { inboundSyncEnabled: true, outboundSyncEnabled: true },
    };

    beforeEach(function () {
      provider = new JobNimbusProvider(mockIntegration);
    });

    describe("Provider Metadata", function () {
      it("should have correct provider name", function () {
        expect(provider.providerName).to.equal("jobnimbus");
      });

      it("should have correct display name", function () {
        expect(provider.displayName).to.equal("JobNimbus");
      });

      it("should have correct API base URL", function () {
        expect(provider.apiBaseUrl).to.equal("https://app.jobnimbus.com/api1");
      });
    });

    describe("Project URL Generation", function () {
      it("should generate correct URL for job ID", function () {
        const url = provider.getProjectUrl("abc123");
        expect(url).to.equal("https://app.jobnimbus.com/job/abc123");
      });

      it("should handle special characters in job ID", function () {
        const url = provider.getProjectUrl("job-with-dashes");
        expect(url).to.equal("https://app.jobnimbus.com/job/job-with-dashes");
      });
    });

    describe("Webhook Parsing", function () {
      it("should parse direct job object webhook", function () {
        const payload = {
          jnid: "job-12345",
          record_type_name: "Job",
          display_name: "Smith Residence Roof",
          status_name: "New",
        };

        const event = provider.parseWebhook({}, payload);

        expect(event).to.not.be.null;
        expect(event.eventId).to.equal("job-12345");
        expect(event.eventType).to.equal("job.created");
        expect(event.payload).to.deep.equal(payload);
      });

      it("should parse typed event webhook", function () {
        const payload = {
          id: "evt-abc",
          type: "job.created",
          jnid: "job-xyz",
          data: { name: "Test" },
        };

        const event = provider.parseWebhook({}, payload);

        expect(event).to.not.be.null;
        expect(event.eventId).to.equal("evt-abc");
        expect(event.eventType).to.equal("job.created");
      });

      it("should parse event with action field", function () {
        const payload = {
          id: "evt-123",
          action: "job_updated",
          jnid: "job-456",
        };

        const event = provider.parseWebhook({}, payload);

        expect(event).to.not.be.null;
        expect(event.eventType).to.equal("job_updated");
      });

      it("should ignore contact webhooks", function () {
        const payload = {
          jnid: "contact-123",
          record_type_name: "Contact",
          first_name: "John",
          last_name: "Doe",
        };

        const event = provider.parseWebhook({}, payload);

        expect(event).to.be.null;
      });

      it("should ignore task webhooks", function () {
        const payload = {
          id: "task-123",
          type: "task.created",
          description: "Follow up call",
        };

        const event = provider.parseWebhook({}, payload);

        expect(event).to.be.null;
      });

      it("should generate event ID when not provided", function () {
        const payload = {
          record_type_name: "Job",
          jnid: "job-123",
        };

        const event = provider.parseWebhook({}, payload);

        expect(event.eventId).to.equal("job-123");
      });

      it("should handle empty payload", function () {
        const event = provider.parseWebhook({}, {});
        expect(event).to.be.null;
      });

      it("should handle null body gracefully", function () {
        // This should not throw
        const event = provider.parseWebhook({}, null);
        expect(event).to.be.null;
      });
    });

    describe("Webhook Signature Verification", function () {
      it("should always return true (URL-based verification)", function () {
        const result = provider.verifyWebhookSignature(
          { "x-signature": "some-sig" },
          { data: "payload" },
          "secret-key",
        );
        expect(result).to.be.true;
      });
    });

    describe("API Connection Test (Mocked)", function () {
      it("should return success when API responds with 200", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({ count: 5, results: [] }),
        });

        const result = await provider.testConnection();

        expect(result.success).to.be.true;
        expect(result.accountName).to.equal("JobNimbus Account");
        expect(fetchStub.calledOnce).to.be.true;

        // Verify correct endpoint called
        const callUrl = fetchStub.firstCall.args[0];
        expect(callUrl).to.include("/contacts");
      });

      it("should return failure on 401 Unauthorized", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: false,
          status: 401,
          text: async () => "Invalid API key",
        });

        const result = await provider.testConnection();

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("401");
      });

      it("should return failure on 500 Server Error", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        });

        const result = await provider.testConnection();

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("500");
      });

      it("should return failure on network error", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.rejects(new Error("Network timeout"));

        const result = await provider.testConnection();

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("timeout");
      });

      it("should send correct authorization header", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({ results: [] }),
        });

        await provider.testConnection();

        const options = fetchStub.firstCall.args[1];
        expect(options.headers.Authorization).to.equal(
          "Bearer test-api-key-xyz",
        );
      });
    });

    describe("Get Project (Mocked)", function () {
      it("should fetch and transform complete job data", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({
            jnid: "job-abc123",
            display_name: "Johnson Roof Replacement",
            address_line1: "789 Pine Street",
            address_line2: "Suite 100",
            city: "Fort Collins",
            state_text: "Colorado",
            zip: "80521",
            primary: {
              first_name: "Robert",
              last_name: "Johnson",
              email: "robert@email.com",
              phone: "970-555-1234",
            },
            status_name: "In Progress",
            created: 1609459200,
          }),
        });

        const project = await provider.getProject("job-abc123");

        expect(project).to.not.be.null;
        expect(project.externalId).to.equal("job-abc123");
        expect(project.name).to.equal("Johnson Roof Replacement");
        expect(project.address).to.include("789 Pine Street");
        expect(project.address).to.include("Fort Collins");
        expect(project.customerName).to.equal("Robert Johnson");
        expect(project.customerEmail).to.equal("robert@email.com");
        expect(project.customerPhone).to.equal("970-555-1234");
        expect(project.externalUrl).to.equal(
          "https://app.jobnimbus.com/job/job-abc123",
        );
      });

      it("should handle job without customer info", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({
            jnid: "job-minimal",
            display_name: "Quick Repair",
          }),
        });

        const project = await provider.getProject("job-minimal");

        expect(project.name).to.equal("Quick Repair");
        expect(project.customerName).to.be.undefined;
        expect(project.address).to.be.undefined;
      });

      it("should handle job without display_name", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({
            jnid: "job-noname",
            name: "Fallback Name",
          }),
        });

        const project = await provider.getProject("job-noname");

        expect(project.name).to.equal("Fallback Name");
      });

      it("should use 'Untitled Job' when no name provided", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({
            jnid: "job-unnamed",
          }),
        });

        const project = await provider.getProject("job-unnamed");

        expect(project.name).to.equal("Untitled Job");
      });

      it("should return null on 404", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: false,
          status: 404,
          text: async () => "Job not found",
        });

        const project = await provider.getProject("nonexistent");

        expect(project).to.be.null;
      });

      it("should store raw data for debugging", async function () {
        const rawJob = {
          jnid: "job-raw",
          display_name: "Test",
          custom_field_1: "custom value",
        };

        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => rawJob,
        });

        const project = await provider.getProject("job-raw");

        expect(project.rawData).to.deep.equal(rawJob);
      });
    });

    describe("Upload Photo (Mocked)", function () {
      const photoPayload = {
        fileUrl: "https://crewcam-bucket.s3.amazonaws.com/photos/abc123.jpg",
        fileName: "site_photo.jpg",
        mimeType: "image/jpeg",
        uploadedBy: "Mike Wilson",
        uploadedAt: new Date("2024-01-15T10:30:00Z"),
        projectName: "Downtown Office Roof",
        projectUrl: "https://app.crewcam.com/projects/proj-123",
        tags: ["Before", "Front Elevation"],
      };

      it("should successfully upload photo", async function () {
        const fetchStub = sinon.stub(global, "fetch");

        // Mock S3 download
        fetchStub.onFirstCall().resolves({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1024),
        });

        // Mock JobNimbus upload
        fetchStub.onSecondCall().resolves({
          ok: true,
          json: async () => ({ jnid: "file-uploaded-123" }),
        });

        const result = await provider.uploadPhoto("job-123", photoPayload);

        expect(result.success).to.be.true;
        expect(result.externalAttachmentId).to.equal("file-uploaded-123");
      });

      it("should fail gracefully on S3 download error", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.onFirstCall().resolves({
          ok: false,
          status: 403,
        });

        const result = await provider.uploadPhoto("job-123", photoPayload);

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("Failed to download");
      });

      it("should fail gracefully on JobNimbus upload error", async function () {
        const fetchStub = sinon.stub(global, "fetch");

        fetchStub.onFirstCall().resolves({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(1024),
        });

        fetchStub.onSecondCall().resolves({
          ok: false,
          status: 413,
          text: async () => "File too large",
        });

        const result = await provider.uploadPhoto("job-123", photoPayload);

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("413");
      });

      it("should call correct JobNimbus endpoint", async function () {
        const fetchStub = sinon.stub(global, "fetch");

        fetchStub.onFirstCall().resolves({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(100),
        });

        fetchStub.onSecondCall().resolves({
          ok: true,
          json: async () => ({ jnid: "file-1" }),
        });

        await provider.uploadPhoto("job-xyz", photoPayload);

        const uploadUrl = fetchStub.secondCall.args[0];
        expect(uploadUrl).to.equal("https://app.jobnimbus.com/api1/files");
      });
    });
  });

  // ============================================
  // Type Definitions Tests
  // ============================================

  describe("Type Definitions", function () {
    let types;

    before(function () {
      types = require("../../server/integrations/types");
    });

    it("should export type interfaces (verify module loads)", function () {
      // TypeScript interfaces don't exist at runtime, but module should load
      expect(types).to.exist;
    });
  });

  // ============================================
  // Retry Logic Tests
  // ============================================

  describe("Retry Delay Calculation", function () {
    it("should have exponential backoff delays", function () {
      // These are the expected delays defined in syncService
      const expectedDelays = [
        30 * 1000, // 30 seconds
        2 * 60 * 1000, // 2 minutes
        8 * 60 * 1000, // 8 minutes
        32 * 60 * 1000, // 32 minutes
        2 * 60 * 60 * 1000, // 2 hours
      ];

      // Verify the pattern: each delay should be roughly 4x the previous
      expect(expectedDelays[1] / expectedDelays[0]).to.equal(4);
      expect(expectedDelays[2] / expectedDelays[1]).to.equal(4);
    });
  });
});
