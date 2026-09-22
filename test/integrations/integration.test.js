/**
 * Integration Module Tests
 *
 * Tests for CRM integration framework including:
 * - Data models (Integration, SyncJob, ProcessedWebhook)
 * - Provider interface and JobNimbus provider
 * - Sync service and retry logic
 * - Webhook handling
 */

const { expect } = require("chai");
const mongoose = require("mongoose");
const sinon = require("sinon");

// These will be available after compilation
let Integration, SyncJob, ProcessedWebhook, Project, Company;
let JobNimbusProvider;
let IntegrationManager, createIntegrationManager, PROVIDER_INFO;
let syncService;

// Mock data
const mockCompanyId = new mongoose.Types.ObjectId();
const mockUserId = new mongoose.Types.ObjectId();
const mockProjectId = new mongoose.Types.ObjectId();

describe("CRM Integrations", function () {
  this.timeout(10000);

  before(async function () {
    // Connect to test database
    const dbPath =
      process.env.DB_PATH || "mongodb://localhost:27017/crewcam-test";
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(dbPath);
    }

    // Import compiled modules
    const db = require("../../server/db");
    Integration = db.Integration;
    SyncJob = db.SyncJob;
    ProcessedWebhook = db.ProcessedWebhook;
    Project = db.Project;
    Company = db.Company;

    const jobnimbus = require("../../server/integrations/providers/jobnimbus");
    JobNimbusProvider = jobnimbus.JobNimbusProvider;

    const manager = require("../../server/integrations/manager");
    IntegrationManager = manager.IntegrationManager;
    createIntegrationManager = manager.createIntegrationManager;
    PROVIDER_INFO = manager.PROVIDER_INFO;

    syncService = require("../../server/integrations/syncService");
  });

  afterEach(async function () {
    // Clean up test data
    await Integration.deleteMany({});
    await SyncJob.deleteMany({});
    await ProcessedWebhook.deleteMany({});
    await Project.deleteMany({ companyId: mockCompanyId });
    sinon.restore();
  });

  // ============================================
  // Data Model Tests
  // ============================================

  describe("Integration Model", function () {
    it("should create an integration with required fields", async function () {
      const integration = await Integration.create({
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "test-api-key-123" },
        webhookSecret: "webhook-secret-456",
        status: "connected",
        settings: {
          inboundSyncEnabled: true,
          outboundSyncEnabled: true,
        },
      });

      expect(integration).to.exist;
      expect(integration.provider).to.equal("jobnimbus");
      expect(integration.status).to.equal("connected");
      expect(integration.credentials.apiKey).to.equal("test-api-key-123");
      expect(integration.settings.inboundSyncEnabled).to.be.true;
    });

    it("should enforce unique constraint on companyId + provider", async function () {
      await Integration.create({
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "key1" },
        webhookSecret: "secret1",
      });

      try {
        await Integration.create({
          companyId: mockCompanyId,
          provider: "jobnimbus",
          credentials: { apiKey: "key2" },
          webhookSecret: "secret2",
        });
        expect.fail("Should have thrown duplicate key error");
      } catch (error) {
        expect(error.code).to.equal(11000);
      }
    });

    it("should allow same provider for different companies", async function () {
      const company2 = new mongoose.Types.ObjectId();

      const int1 = await Integration.create({
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "key1" },
        webhookSecret: "secret1",
      });

      const int2 = await Integration.create({
        companyId: company2,
        provider: "jobnimbus",
        credentials: { apiKey: "key2" },
        webhookSecret: "secret2",
      });

      expect(int1._id.toString()).to.not.equal(int2._id.toString());
    });

    it("should validate provider enum", async function () {
      try {
        await Integration.create({
          companyId: mockCompanyId,
          provider: "invalid-provider",
          credentials: { apiKey: "key" },
          webhookSecret: "secret",
        });
        expect.fail("Should have thrown validation error");
      } catch (error) {
        expect(error.name).to.equal("ValidationError");
      }
    });

    it("should store lastError correctly", async function () {
      const integration = await Integration.create({
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "key" },
        webhookSecret: "secret",
        lastError: {
          message: "Connection timeout",
          occurredAt: new Date(),
          code: "TIMEOUT",
        },
      });

      expect(integration.lastError.message).to.equal("Connection timeout");
      expect(integration.lastError.code).to.equal("TIMEOUT");
    });
  });

  describe("SyncJob Model", function () {
    let integrationId;

    beforeEach(async function () {
      const integration = await Integration.create({
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "key" },
        webhookSecret: "secret",
      });
      integrationId = integration._id;
    });

    it("should create an inbound sync job", async function () {
      const job = await SyncJob.create({
        integrationId,
        type: "inbound_project",
        status: "pending",
        payload: { externalId: "jn-123", name: "Test Job" },
      });

      expect(job.type).to.equal("inbound_project");
      expect(job.status).to.equal("pending");
      expect(job.attempts).to.equal(0);
      expect(job.maxAttempts).to.equal(5);
    });

    it("should create an outbound sync job", async function () {
      const job = await SyncJob.create({
        integrationId,
        projectId: mockProjectId,
        type: "outbound_photo",
        status: "pending",
        payload: {
          externalProjectId: "jn-123",
          photo: { fileUrl: "https://s3.amazonaws.com/photo.jpg" },
        },
      });

      expect(job.type).to.equal("outbound_photo");
      expect(job.projectId.toString()).to.equal(mockProjectId.toString());
    });

    it("should track retry attempts", async function () {
      const job = await SyncJob.create({
        integrationId,
        type: "inbound_project",
        status: "pending",
        payload: { externalId: "jn-123" },
      });

      // Simulate retries
      await SyncJob.findByIdAndUpdate(job._id, {
        attempts: 3,
        lastAttemptAt: new Date(),
        nextRetryAt: new Date(Date.now() + 60000),
      });

      const updated = await SyncJob.findById(job._id);
      expect(updated.attempts).to.equal(3);
      expect(updated.nextRetryAt).to.exist;
    });

    it("should store result on completion", async function () {
      const job = await SyncJob.create({
        integrationId,
        type: "inbound_project",
        status: "completed",
        payload: { externalId: "jn-123" },
        result: {
          success: true,
          externalId: "jn-123",
        },
      });

      expect(job.result.success).to.be.true;
      expect(job.result.externalId).to.equal("jn-123");
    });

    it("should store error on failure", async function () {
      const job = await SyncJob.create({
        integrationId,
        type: "outbound_photo",
        status: "failed",
        payload: { externalProjectId: "jn-123" },
        attempts: 5,
        result: {
          success: false,
          errorMessage: "API rate limit exceeded",
        },
      });

      expect(job.status).to.equal("failed");
      expect(job.result.success).to.be.false;
      expect(job.result.errorMessage).to.include("rate limit");
    });
  });

  describe("ProcessedWebhook Model", function () {
    it("should create a processed webhook record", async function () {
      const record = await ProcessedWebhook.create({
        eventId: "evt-123",
        provider: "jobnimbus",
      });

      expect(record.eventId).to.equal("evt-123");
      expect(record.provider).to.equal("jobnimbus");
      expect(record.processedAt).to.exist;
    });

    it("should enforce unique constraint on eventId + provider", async function () {
      await ProcessedWebhook.create({
        eventId: "evt-123",
        provider: "jobnimbus",
      });

      try {
        await ProcessedWebhook.create({
          eventId: "evt-123",
          provider: "jobnimbus",
        });
        expect.fail("Should have thrown duplicate key error");
      } catch (error) {
        expect(error.code).to.equal(11000);
      }
    });

    it("should allow same eventId for different providers", async function () {
      await ProcessedWebhook.create({
        eventId: "evt-123",
        provider: "jobnimbus",
      });

      const record = await ProcessedWebhook.create({
        eventId: "evt-123",
        provider: "roofr",
      });

      expect(record.provider).to.equal("roofr");
    });
  });

  describe("Project External Mapping", function () {
    it("should store external mapping on project", async function () {
      const project = await Project.create({
        name: "Test Project",
        companyId: mockCompanyId,
        externalMapping: {
          system: "jobnimbus",
          externalId: "jn-job-123",
          externalUrl: "https://app.jobnimbus.com/job/jn-job-123",
        },
      });

      expect(project.externalMapping.system).to.equal("jobnimbus");
      expect(project.externalMapping.externalId).to.equal("jn-job-123");
    });

    it("should enforce unique external mapping per company", async function () {
      await Project.create({
        name: "Project 1",
        companyId: mockCompanyId,
        externalMapping: {
          system: "jobnimbus",
          externalId: "jn-job-123",
        },
      });

      try {
        await Project.create({
          name: "Project 2",
          companyId: mockCompanyId,
          externalMapping: {
            system: "jobnimbus",
            externalId: "jn-job-123",
          },
        });
        expect.fail("Should have thrown duplicate key error");
      } catch (error) {
        expect(error.code).to.equal(11000);
      }
    });

    it("should track last outbound sync", async function () {
      const project = await Project.create({
        name: "Test Project",
        companyId: mockCompanyId,
        externalMapping: {
          system: "jobnimbus",
          externalId: "jn-job-123",
          lastOutboundSync: new Date(),
        },
      });

      expect(project.externalMapping.lastOutboundSync).to.exist;
    });
  });

  // ============================================
  // Provider Tests
  // ============================================

  describe("JobNimbus Provider", function () {
    let provider;
    let mockIntegration;

    beforeEach(function () {
      mockIntegration = {
        _id: new mongoose.Types.ObjectId(),
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "test-api-key" },
        webhookSecret: "test-secret",
        settings: {
          inboundSyncEnabled: true,
          outboundSyncEnabled: true,
        },
      };
      provider = new JobNimbusProvider(mockIntegration);
    });

    it("should have correct provider metadata", function () {
      expect(provider.providerName).to.equal("jobnimbus");
      expect(provider.displayName).to.equal("JobNimbus");
      expect(provider.apiBaseUrl).to.equal("https://app.jobnimbus.com/api1");
    });

    it("should generate correct project URL", function () {
      const url = provider.getProjectUrl("jn-123");
      expect(url).to.equal("https://app.jobnimbus.com/job/jn-123");
    });

    it("should parse job webhook event", function () {
      const event = provider.parseWebhook(
        { "content-type": "application/json" },
        {
          jnid: "job-123",
          record_type_name: "Job",
          display_name: "Test Job",
        },
      );

      expect(event).to.exist;
      expect(event.eventId).to.equal("job-123");
      expect(event.eventType).to.equal("job.created");
    });

    it("should ignore non-job webhook events", function () {
      const event = provider.parseWebhook(
        {},
        {
          jnid: "contact-123",
          record_type_name: "Contact",
        },
      );

      expect(event).to.be.null;
    });

    it("should parse typed webhook events", function () {
      const event = provider.parseWebhook(
        {},
        {
          id: "evt-456",
          type: "job.created",
          jnid: "job-789",
        },
      );

      expect(event).to.exist;
      expect(event.eventId).to.equal("evt-456");
      expect(event.eventType).to.equal("job.created");
    });

    it("should verify webhook signature (always true for JobNimbus)", function () {
      const result = provider.verifyWebhookSignature({}, {}, "secret");
      expect(result).to.be.true;
    });

    describe("testConnection (mocked)", function () {
      it("should return success when API responds", async function () {
        // Mock the fetch call
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({ count: 1, results: [{ jnid: "contact-1" }] }),
        });

        const result = await provider.testConnection();

        expect(result.success).to.be.true;
        expect(result.accountName).to.equal("JobNimbus Account");

        fetchStub.restore();
      });

      it("should return failure when API errors", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: false,
          status: 401,
          text: async () => "Unauthorized",
        });

        const result = await provider.testConnection();

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("401");

        fetchStub.restore();
      });
    });

    describe("getProject (mocked)", function () {
      it("should fetch and transform job data", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({
            jnid: "job-123",
            display_name: "Smith Residence Roof",
            address_line1: "123 Main St",
            city: "Denver",
            state_text: "CO",
            zip: "80202",
            primary: {
              first_name: "John",
              last_name: "Smith",
              email: "john@example.com",
              phone: "555-1234",
            },
          }),
        });

        const project = await provider.getProject("job-123");

        expect(project).to.exist;
        expect(project.externalId).to.equal("job-123");
        expect(project.name).to.equal("Smith Residence Roof");
        expect(project.address).to.equal("123 Main St, Denver, CO, 80202");
        expect(project.customerName).to.equal("John Smith");
        expect(project.customerEmail).to.equal("john@example.com");

        fetchStub.restore();
      });

      it("should return null when job not found", async function () {
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: false,
          status: 404,
          text: async () => "Not found",
        });

        const project = await provider.getProject("nonexistent");

        expect(project).to.be.null;

        fetchStub.restore();
      });
    });

    describe("uploadPhoto (mocked)", function () {
      it("should upload photo and return success", async function () {
        const fetchStub = sinon.stub(global, "fetch");

        // First call: download photo from S3
        fetchStub.onFirstCall().resolves({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(100),
        });

        // Second call: upload to JobNimbus
        fetchStub.onSecondCall().resolves({
          ok: true,
          json: async () => ({ jnid: "file-456" }),
        });

        const result = await provider.uploadPhoto("job-123", {
          fileUrl: "https://s3.amazonaws.com/photo.jpg",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          uploadedBy: "John Doe",
          uploadedAt: new Date(),
          projectName: "Test Project",
          projectUrl: "https://app.crewcam.com/projects/123",
          tags: ["Before", "Exterior"],
        });

        expect(result.success).to.be.true;
        expect(result.externalAttachmentId).to.equal("file-456");

        fetchStub.restore();
      });

      it("should return failure when upload fails", async function () {
        const fetchStub = sinon.stub(global, "fetch");

        fetchStub.onFirstCall().resolves({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(100),
        });

        fetchStub.onSecondCall().resolves({
          ok: false,
          status: 400,
          text: async () => "Invalid file format",
        });

        const result = await provider.uploadPhoto("job-123", {
          fileUrl: "https://s3.amazonaws.com/photo.jpg",
          fileName: "photo.jpg",
          mimeType: "image/jpeg",
          uploadedBy: "John Doe",
          uploadedAt: new Date(),
          projectName: "Test Project",
          projectUrl: "https://app.crewcam.com/projects/123",
        });

        expect(result.success).to.be.false;
        expect(result.errorMessage).to.include("400");

        fetchStub.restore();
      });
    });
  });

  // ============================================
  // Integration Manager Tests
  // ============================================

  describe("Integration Manager", function () {
    it("should list available providers", function () {
      expect(PROVIDER_INFO).to.have.property("jobnimbus");
      expect(PROVIDER_INFO.jobnimbus.displayName).to.equal("JobNimbus");
      expect(PROVIDER_INFO.jobnimbus.available).to.be.true;
    });

    it("should create manager for valid integration", function () {
      const integration = {
        _id: new mongoose.Types.ObjectId(),
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "test-key" },
        webhookSecret: "secret",
        settings: { inboundSyncEnabled: true, outboundSyncEnabled: true },
      };

      const manager = createIntegrationManager(integration);

      expect(manager.providerName).to.equal("jobnimbus");
      expect(manager.displayName).to.equal("JobNimbus");
    });

    it("should throw for invalid provider", function () {
      const integration = {
        _id: new mongoose.Types.ObjectId(),
        provider: "invalid",
        credentials: { apiKey: "test-key" },
      };

      expect(() => createIntegrationManager(integration)).to.throw(
        "Unknown provider",
      );
    });
  });

  // ============================================
  // Sync Service Tests
  // ============================================

  describe("Sync Service", function () {
    let integration;

    beforeEach(async function () {
      integration = await Integration.create({
        companyId: mockCompanyId,
        provider: "jobnimbus",
        credentials: { apiKey: "test-key" },
        webhookSecret: "secret",
        status: "connected",
        settings: { inboundSyncEnabled: true, outboundSyncEnabled: true },
      });
    });

    describe("Webhook Idempotency", function () {
      it("should detect unprocessed webhook", async function () {
        const result = await syncService.isWebhookProcessed(
          "new-event",
          "jobnimbus",
        );
        expect(result).to.be.false;
      });

      it("should mark webhook as processed", async function () {
        await syncService.markWebhookProcessed("evt-123", "jobnimbus");

        const result = await syncService.isWebhookProcessed(
          "evt-123",
          "jobnimbus",
        );
        expect(result).to.be.true;
      });

      it("should handle duplicate marking gracefully", async function () {
        await syncService.markWebhookProcessed("evt-123", "jobnimbus");

        // Should not throw
        await syncService.markWebhookProcessed("evt-123", "jobnimbus");

        const count = await ProcessedWebhook.countDocuments({
          eventId: "evt-123",
        });
        expect(count).to.equal(1);
      });
    });

    describe("Inbound Sync Job Creation", function () {
      it("should create inbound sync job", async function () {
        const job = await syncService.createInboundSyncJob(
          integration._id,
          "jn-job-123",
          { display_name: "Test Job" },
        );

        expect(job).to.exist;
        expect(job.type).to.equal("inbound_project");
        expect(job.status).to.equal("pending");
        expect(job.payload.externalId).to.equal("jn-job-123");
      });
    });

    describe("Outbound Sync Job Creation", function () {
      it("should create outbound sync job", async function () {
        const job = await syncService.createOutboundSyncJob(
          integration._id,
          mockProjectId,
          "jn-job-123",
          {
            fileUrl: "https://s3.amazonaws.com/photo.jpg",
            fileName: "photo.jpg",
            mimeType: "image/jpeg",
            uploadedBy: "Test User",
            uploadedAt: new Date(),
            projectName: "Test Project",
            projectUrl: "https://app.crewcam.com/projects/123",
          },
        );

        expect(job).to.exist;
        expect(job.type).to.equal("outbound_photo");
        expect(job.projectId.toString()).to.equal(mockProjectId.toString());
        expect(job.payload.externalProjectId).to.equal("jn-job-123");
      });
    });
  });

  // ============================================
  // Integration Flow Tests (End-to-End)
  // ============================================

  describe("Integration Flows", function () {
    describe("Inbound Sync Flow", function () {
      it("should create project from webhook payload", async function () {
        // Create integration
        const integration = await Integration.create({
          companyId: mockCompanyId,
          provider: "jobnimbus",
          credentials: { apiKey: "test-key" },
          webhookSecret: "secret",
          status: "connected",
          settings: { inboundSyncEnabled: true, outboundSyncEnabled: true },
        });

        // Mock the provider's getProject method
        const fetchStub = sinon.stub(global, "fetch");
        fetchStub.resolves({
          ok: true,
          json: async () => ({
            jnid: "jn-123",
            display_name: "Test Roof Job",
            address_line1: "456 Oak Ave",
            city: "Boulder",
            state_text: "CO",
            zip: "80301",
          }),
        });

        // Create sync job and wait for processing
        await syncService.createInboundSyncJob(integration._id, "jn-123", {
          jnid: "jn-123",
        });

        // Wait for async processing
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check project was created
        const project = await Project.findOne({
          companyId: mockCompanyId,
          "externalMapping.externalId": "jn-123",
        });

        expect(project).to.exist;
        expect(project.name).to.equal("Test Roof Job");
        expect(project.externalMapping.system).to.equal("jobnimbus");

        fetchStub.restore();
      });

      it("should skip duplicate projects", async function () {
        const integration = await Integration.create({
          companyId: mockCompanyId,
          provider: "jobnimbus",
          credentials: { apiKey: "test-key" },
          webhookSecret: "secret",
          status: "connected",
          settings: { inboundSyncEnabled: true, outboundSyncEnabled: true },
        });

        // Create existing project
        await Project.create({
          name: "Existing Project",
          companyId: mockCompanyId,
          externalMapping: {
            system: "jobnimbus",
            externalId: "jn-existing",
          },
        });

        // Try to sync same external ID
        const job = await syncService.createInboundSyncJob(
          integration._id,
          "jn-existing",
          { jnid: "jn-existing" },
        );

        // Wait for processing
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check job was marked complete (not failed)
        const completedJob = await SyncJob.findById(job._id);
        expect(completedJob.status).to.equal("completed");
        expect(completedJob.result.errorMessage).to.include("already exists");
      });
    });
  });
});
