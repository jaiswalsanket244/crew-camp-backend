import { Request, Response, NextFunction } from "express";
import { RevenueCatlogs, Integration } from "../../db/index";
import { stripeService } from "../../services/stripeService";
import {
  SuccessResponse,
  ErrorResponse,
} from "../../utils/helpers/apiResponse";
import * as status from "http-status";
import {
  SUBSCRIPTION_EVENTS,
  SUBSCRIPTION_STATUS,
} from "../../utils/enums/enums";
import { UserHelper } from "../user/helper";
import { createIntegrationManager } from "../../integrations/manager";
import {
  claimWebhookEvent,
  createInboundSyncJob,
  releaseWebhookEvent,
} from "../../integrations/syncService";
import { buildWebhookEventKey } from "../../integrations/webhookHelpers";
import { IIntegration } from "../../integrations";
import { config } from "../../utils/configuration/config";
import { recordStripeRevenueEvent } from "./helpers";
import { Validator } from "node-input-validator";
import {
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUS,
} from "../../utils/enums/integrations";

export class WebhookRoutes {
  constructor() {}

  public static async subscriptionWebhook(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      switch (req.body.event?.type) {
        case SUBSCRIPTION_EVENTS.TRANSFER:
          await RevenueCatlogs.create({ event: req.body.event });
          break;
        default:
          const {
            product_id,
            app_user_id,
            price_in_purchased_currency,
            currency,
            event_timestamp_ms,
            type,
            expiration_at_ms,
          } = req.body.event;
          const obj = {
            userId: app_user_id,
            product_id,
            price: price_in_purchased_currency + " " + currency,
            time: new Date(event_timestamp_ms),
            type,
          };
          await RevenueCatlogs.create({ event: req.body.event, ...obj });

          const update: any = {
            subscriptionStatus: SUBSCRIPTION_STATUS.NO_SUBSCRIPTION,
          };
          if (
            [
              SUBSCRIPTION_EVENTS.INITIAL_PURCHASE,
              SUBSCRIPTION_EVENTS.PRODUCT_CHANGE,
              SUBSCRIPTION_EVENTS.RENEWAL,
            ].includes(type)
          ) {
            update.subscriptionStatus = SUBSCRIPTION_STATUS.ACTIVE;
            update.subscriptionActiveUntil = expiration_at_ms;
          } else if (
            [
              SUBSCRIPTION_EVENTS.EXPIRATION,
              SUBSCRIPTION_EVENTS.CANCELLATION,
            ].includes(type)
          ) {
            update.subscriptionStatus = SUBSCRIPTION_STATUS.EXPIRED;
          }
          await UserHelper.findByIdAndUpdate(obj.userId, update);
          break;
      }

      return SuccessResponse(res, status.OK, {
        message: "Subscription created successfully.",
      });
    } catch (error) {
      next(error);
    }
  }

  public static async stripeWebhook(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      // Verify the Stripe signature against the raw request body when a
      // webhook secret is configured. Falls back to the parsed body only when
      // verification can't run (missing secret/signature/raw body) so existing
      // billing behavior is never broken.
      let event = req.body;
      const signature = req.headers["stripe-signature"];
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      if (config.STRIPE_WEBHOOK_SECRET && signature && rawBody) {
        try {
          event = await stripeService.constructEvent(rawBody, signature);
        } catch (err) {
          console.error("Stripe webhook signature verification failed:", err);
          return ErrorResponse(res, status.BAD_REQUEST, {
            message: "Webhook signature verification failed",
          });
        }
      }

      // Record a raw revenue fact for money-moving events (idempotent).
      await recordStripeRevenueEvent(event);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const subscriptionId = session?.subscription;

        if (subscriptionId) {
          const subscriptionData =
            await stripeService.getSubscriptionData(subscriptionId);

          if (subscriptionData?.metadata?.isOneTimePayment == "true") {
            await stripeService.cancelSubscriptionAfterBillingCycle(
              subscriptionId,
            );
          }
        }
      }

      if (event.data.object.customer) {
        const customerId = event.data.object.customer;
        const [subscriptionStatus, user] = await Promise.all([
          stripeService.getSubscriptionStatus(customerId),
          UserHelper.findOne({ stripeCustomerId: customerId }),
        ]);

        if (user?._id) {
          await UserHelper.findByIdAndUpdate(user._id, subscriptionStatus);
        }
      }

      return SuccessResponse(res, status.OK, {
        message: "Subscription created successfully.",
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /webhook/jobnimbus
   * Handle incoming webhooks from JobNimbus.
   * Query param 'secret' is used for verification.
   */
  public static async jobnimbusWebhook(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    // Mark next as intentionally unused (we handle errors inline for webhooks)
    void next;
    try {
      const { secret } = req.query;

      // Verify webhook secret
      if (!secret || typeof secret !== "string") {
        console.warn("JobNimbus webhook received without secret");
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Invalid webhook secret",
        });
      }

      // Find integration by webhook secret
      const integration = await Integration.findOne({
        provider: "jobnimbus",
        webhookSecret: secret,
        status: "connected",
      });

      if (!integration) {
        console.warn("JobNimbus webhook received with unknown secret");
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Invalid webhook secret",
        });
      }

      // Return 200 immediately (process async)
      res.status(200).json({ received: true });

      // Process webhook asynchronously
      WebhookRoutes.processJobNimbusWebhook(
        integration as unknown as IIntegration,
        req.headers as Record<string, string>,
        req.body,
      ).catch((error) => {
        console.error("Error processing JobNimbus webhook:", error);
      });
    } catch (error) {
      // Still return 200 to prevent retries
      console.error("JobNimbus webhook error:", error);
      res.status(200).json({ received: true, error: "Processing failed" });
    }
  }

  /**
   * Process JobNimbus webhook asynchronously.
   */
  private static async processJobNimbusWebhook(
    integration: IIntegration,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<void> {
    try {
      const manager = createIntegrationManager(integration);

      // Parse webhook event
      const event = manager.parseWebhook(headers, body);
      if (!event) {
        return;
      }

      // Extract JobNimbus job ID (jnid) and CrewCam project ID (external_id)
      const jobNimbusId = event.payload.jnid as string;
      if (!jobNimbusId) {
        return;
      }

      // Claim the delivery before doing any work. JobNimbus can deliver the same
      // payload twice in the same second; without this both deliveries enqueue a
      // sync job and race to create the project.
      const eventKey = buildWebhookEventKey(event.eventId, event.payload);
      const claimed = await claimWebhookEvent(eventKey, "jobnimbus");
      if (!claimed) {
        return;
      }

      try {
        // Create inbound sync job
        // The sync service will handle:
        // - Creating new projects from JobNimbus jobs
        // - Updating existing projects
        // - Syncing tags
        await createInboundSyncJob(integration._id, jobNimbusId, event.payload);
      } catch (error) {
        // Nothing durable was enqueued, so let a redelivery try again.
        await releaseWebhookEvent(eventKey, "jobnimbus").catch(() => undefined);
        throw error;
      }
    } catch (error) {
      console.error("Error processing JobNimbus webhook:", error);
      throw error;
    }
  }
  /**
   * POST /webhook/proline?secret=<webhookSecret>
   * Handle incoming project create/update webhooks from Proline.
   *
   * Proline has no request signing and no event envelope: it posts the whole
   * project record and the `secret` query param is the only credential. Every
   * delivery is treated as an upsert keyed on `project_id`.
   */
  public static async prolineWebhook(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    // Errors are handled inline for webhooks so the sender always gets a 200.
    void next;
    try {
      const validator = new Validator(
        { secret: req.query.secret, project_id: req.body?.project_id },
        {
          secret: "required|string",
          project_id: "required|string",
        },
      );

      if (!(await validator.check())) {
        console.warn("Proline webhook rejected:", validator.errors);
        return ErrorResponse(res, status.UNPROCESSABLE_ENTITY, {
          message: validator.errors,
        });
      }

      const secret = req.query.secret as string;

      // Find the connected integration this secret belongs to
      const integration = await Integration.findOne({
        provider: INTEGRATION_PROVIDERS.proline,
        webhookSecret: secret,
        status: INTEGRATION_STATUS.connected,
      });

      if (!integration) {
        console.warn("Proline webhook received with unknown secret");
        return ErrorResponse(res, status.UNAUTHORIZED, {
          message: "Invalid webhook secret",
        });
      }

      // Acknowledge immediately, then process out of band
      res.status(status.OK).json({ received: true });

      WebhookRoutes.processProlineWebhook(
        integration as unknown as IIntegration,
        req.headers as Record<string, string>,
        req.body,
      ).catch((error) => {
        console.error("Error processing Proline webhook:", error);
      });
    } catch (error) {
      // Still return 200 to prevent Proline retry storms
      console.error("Proline webhook error:", error);
      res
        .status(status.OK)
        .json({ received: true, error: "Processing failed" });
    }
  }

  /**
   * Process a Proline webhook asynchronously.
   */
  private static async processProlineWebhook(
    integration: IIntegration,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<void> {
    const manager = createIntegrationManager(integration);

    const event = manager.parseWebhook(headers, body);
    if (!event) {
      return;
    }

    const prolineProjectId = event.payload.project_id as string;
    if (!prolineProjectId) {
      return;
    }

    // Claim the delivery before doing any work. Proline sends the record id
    // rather than a per-delivery id, so the key folds in a payload hash:
    // byte-identical redeliveries collapse (no duplicate projects) while real
    // updates to the same project still get through.
    const eventKey = buildWebhookEventKey(event.eventId, event.payload);
    const claimed = await claimWebhookEvent(
      eventKey,
      INTEGRATION_PROVIDERS.proline,
    );
    if (!claimed) {
      return;
    }

    try {
      // The sync service upserts the CrewCam project and syncs tags.
      await createInboundSyncJob(
        integration._id,
        prolineProjectId,
        event.payload,
      );
    } catch (error) {
      // Nothing durable was enqueued, so let a redelivery try again.
      await releaseWebhookEvent(eventKey, INTEGRATION_PROVIDERS.proline).catch(
        () => undefined,
      );
      throw error;
    }
  }
}
