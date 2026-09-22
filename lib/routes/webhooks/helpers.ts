import { RevenueEvent } from "../../db/index";
import { UserHelper } from "../user/helper";
import {
  PAYMENT_CHANNEL,
  PAYMENT_PROVIDER,
  REVENUE_EVENT_TYPE,
} from "../../utils/enums/enums";

// Minimal shape of the Stripe event fields we read. Stripe's SDK types are
// broad unions; we only touch a handful of fields so a narrow local type keeps
// this readable without pulling `any` through the codebase.
interface StripeEventLike {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

interface RevenueMapping {
  event_type: REVENUE_EVENT_TYPE;
  amount_gross: number;
  currency?: string;
  payment_customer_id?: string;
  provider_transaction_id?: string;
  timestamp: Date;
}

// Stripe amounts are integer minor units (e.g. cents). We store the raw
// provider amount as a fact; conversion happens downstream in reporting.
const toDate = (unixSeconds: unknown): Date =>
  typeof unixSeconds === "number" ? new Date(unixSeconds * 1000) : new Date();

/**
 * Map a Stripe webhook event to a revenue fact, or return null when the event
 * does not represent money moving. We treat `invoice.payment_succeeded` as the
 * single authoritative "money moved" event (avoids double-counting the same
 * dollar across checkout/invoice events) and additionally record trial starts
 * from `customer.subscription.created`.
 */
export const mapStripeEventToRevenue = (
  event: StripeEventLike,
): RevenueMapping | null => {
  const object = event?.data?.object ?? {};

  switch (event?.type) {
    case "invoice.payment_succeeded": {
      const amount =
        typeof object.amount_paid === "number" ? object.amount_paid : 0;
      // Ignore $0 invoices (e.g. fully-discounted / trial invoices) — the
      // trial start is captured separately below.
      if (amount <= 0) return null;

      const billingReason = object.billing_reason as string | undefined;
      let eventType: REVENUE_EVENT_TYPE;
      if (billingReason === "subscription_create") {
        eventType = REVENUE_EVENT_TYPE.SUBSCRIPTION_CREATED;
      } else if (billingReason === "subscription_cycle") {
        eventType = REVENUE_EVENT_TYPE.RENEWAL;
      } else if (billingReason === "subscription_update") {
        eventType = REVENUE_EVENT_TYPE.UPGRADE;
      } else {
        // Any other paid subscription invoice is treated as a renewal.
        eventType = REVENUE_EVENT_TYPE.RENEWAL;
      }

      return {
        event_type: eventType,
        amount_gross: amount,
        currency: object.currency as string | undefined,
        payment_customer_id: object.customer as string | undefined,
        provider_transaction_id:
          (object.payment_intent as string | undefined) ??
          (object.id as string | undefined),
        timestamp: toDate(object.created),
      };
    }

    case "customer.subscription.created": {
      // Only record the trial start here; a paid conversion is captured by the
      // subsequent invoice.payment_succeeded so we don't double-count.
      if (object.status !== "trialing") return null;

      return {
        event_type: REVENUE_EVENT_TYPE.TRIAL_START,
        amount_gross: 0,
        currency: object.currency as string | undefined,
        payment_customer_id: object.customer as string | undefined,
        provider_transaction_id: object.id as string | undefined,
        timestamp: toDate(object.created),
      };
    }

    default:
      return null;
  }
};

/**
 * Persist a revenue fact for a Stripe event, idempotently. The unique
 * {payment_provider, provider_event_id} index plus $setOnInsert guarantees a
 * webhook retry (same event.id) never creates a duplicate row.
 */
export const recordStripeRevenueEvent = async (
  event: StripeEventLike,
): Promise<void> => {
  const providerEventId = event?.id;
  if (!providerEventId) return;

  const mapping = mapStripeEventToRevenue(event);
  if (!mapping) return;

  // Resolve the signup user via the Stripe customer id (identity bridge).
  let userId: unknown = null;
  if (mapping.payment_customer_id) {
    const user = await UserHelper.findOne({
      stripeCustomerId: mapping.payment_customer_id,
    });
    userId = user?._id ?? null;
  }

  await RevenueEvent.updateOne(
    {
      payment_provider: PAYMENT_PROVIDER.STRIPE,
      provider_event_id: providerEventId,
    },
    {
      $setOnInsert: {
        user_id: userId,
        payment_provider: PAYMENT_PROVIDER.STRIPE,
        payment_channel: PAYMENT_CHANNEL.STRIPE_WEB,
        payment_customer_id: mapping.payment_customer_id,
        provider_transaction_id: mapping.provider_transaction_id,
        amount_gross: mapping.amount_gross,
        currency: mapping.currency,
        event_type: mapping.event_type,
        timestamp: mapping.timestamp,
      },
    },
    { upsert: true },
  );
};
