import * as mongoose from "mongoose";
import {
  REVENUE_EVENT_TYPES,
  PAYMENT_PROVIDER,
  PAYMENT_CHANNEL,
} from "../utils/enums/enums";

const ObjectId = mongoose.Schema.Types.ObjectId;

export interface IRevenueEvent {
  _id: mongoose.Types.ObjectId;
  user_id: mongoose.Types.ObjectId;
  payment_provider: string;
  payment_channel: string;
  payment_customer_id: string;
  provider_event_id: string;
  provider_transaction_id: string;
  amount_gross: number;
  currency: string;
  event_type: string;
  timestamp: Date;
}

// Raw revenue facts written on every money-moving payment webhook. Stored in a
// provider-ready shape so non-Stripe channels reuse the same collection. This
// collection only records facts — CAC/LTV are calculated downstream.
export const RevenueEventSchema = new mongoose.Schema(
  {
    user_id: {
      type: ObjectId,
      ref: "User",
      required: false, // may be null if the customer can't be resolved yet
    },
    payment_provider: {
      type: String,
      enum: Object.values(PAYMENT_PROVIDER),
      required: true,
    },
    payment_channel: {
      type: String,
      enum: Object.values(PAYMENT_CHANNEL),
      required: true,
    },
    payment_customer_id: {
      type: String,
      required: false,
    },
    // Provider event id (e.g. Stripe event.id) — drives idempotency/dedupe.
    provider_event_id: {
      type: String,
      required: true,
    },
    // Provider transaction id (e.g. Stripe invoice / payment_intent id).
    provider_transaction_id: {
      type: String,
      required: false,
    },
    amount_gross: {
      type: Number,
      required: true,
      default: 0,
    },
    currency: {
      type: String,
      required: false,
    },
    event_type: {
      type: String,
      enum: REVENUE_EVENT_TYPES,
      required: true,
    },
    // Time the money actually moved, as reported by the provider.
    timestamp: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// Idempotency: a given provider event maps to exactly one revenue row, so
// webhook retries (same event.id) cannot create duplicates.
RevenueEventSchema.index(
  { payment_provider: 1, provider_event_id: 1 },
  { unique: true },
);
