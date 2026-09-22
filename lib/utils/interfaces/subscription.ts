export interface SubscriptionStatusType {
  subscriptionPlan: string;
  subscriptionStatus: string;
  subscriptionBoughtFrom: string;
  subscriptionActiveUntil?: Date;
  subscriptionId?: string;
}

// Plaintext customer fields surfaced to the web thank-you page so it can populate
// the Meta Purchase dataLayer event (user_data). The Meta pixel hashes these
// browser-side; we never hash or send them anywhere else. Empty fields are
// stripped before sending so blanks don't degrade Meta match quality. Shape is
// kept identical to the web app's PurchaseUserData contract.
export interface PurchaseUserData {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
}
