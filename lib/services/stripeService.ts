import { config } from "../utils/configuration/config";
import { Payment } from "../db/index";
import {
  SUBSCRIPTION_PURCHASE_STORE,
  SUBSCRIPTION_STATUS,
} from "../utils/enums/enums";
import { SubscriptionStatusType } from "../utils/interfaces/subscription";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);

// Marks the Billing Portal configuration this service owns, so it can be found
// again and refreshed instead of a new one being created on every portal open.
const MANAGED_PORTAL_CONFIGURATION_KEY = "crewCamManagedPortal";

class StripeService {
  constructor() {}

  // Cached id of the managed portal configuration, with the catalog signature it
  // was built from, so Stripe is only written to when the plan catalog changes.
  private portalConfiguration: { id: string; signature: string } | null = null;

  public getUserViewablePlans = () => {
    return ["pp1", "pp2", "pp3", "pp4", "pp6", "pp7", "pp8", "pp9"];
  };

  public createStripeCustomer = async (name: string, email: string) => {
    return stripe.customers.create({
      name,
      email,
    });
  };

  public updateCustomerEmail = async (customerId: string, email: string) => {
    return stripe.customers.update(customerId, { email });
  };

  public findUserByEmail = async (email: string) => {
    const customers = await stripe.customers.list({
      email: email,
      limit: 1, // Limit the results to 1 to quickly find the customer
    });
    return customers?.data?.[0]?.id;
  };

  public createPrice = async (
    productId: string,
    customerId: string,
    unit_amount: number,
    reccuringInterval?: string,
  ) => {
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: unit_amount * 100,
      product: productId,
      recurring: { interval: reccuringInterval },
    });
    return price;
  };

  public createPaymentLink = async (
    price: string,
    customerId: string,
    isOneTimePayment?: boolean,
    successId?: string,
  ) => {
    let success_url = `${config.APP_URL}/subscription/`;
    if (successId) {
      // Stripe replaces {CHECKOUT_SESSION_ID} with the real session id on redirect.
      // The backend success route forwards it to the web app's thank-you page so it
      // can read purchase details back via getCheckoutSession for conversion tracking.
      success_url = `${config.API_URL}/subscription/success?successId=${successId}&session_id={CHECKOUT_SESSION_ID}`;
    }

    const payment = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          isOneTimePayment,
        },
      },
      allow_promotion_codes: true,
      success_url,
      cancel_url: config.APP_URL,
    });
    return payment.url;
  };

  // Retrieves a completed Checkout Session with its line items expanded, used by the
  // thank-you page to surface purchase details (amount, currency, items) for tracking.
  public getCheckoutSession = async (sessionId: string) => {
    return stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });
  };

  // The plan catalog customers may switch between inside the Billing Portal:
  // active products whose plan key is one of getUserViewablePlans(), each at its
  // default price — the same catalog getStripeProducts and the purchase flow use.
  // Custom prices created for an individual customer are never listed.
  public getPortalUpdatableProducts = async () => {
    const products = await this.getProductList();
    const viewablePlans = this.getUserViewablePlans();

    return products
      .filter(
        (product) =>
          viewablePlans.includes(product.name?.split("_")[1]) &&
          !!product.default_price,
      )
      .map((product) => ({
        product: product.id,
        prices: [
          typeof product.default_price === "string"
            ? product.default_price
            : product.default_price.id,
        ],
      }));
  };

  // Billing Portal configuration pinned to the current plan catalog. Stripe's
  // account-default configuration offers every product enabled on the account,
  // which would put one-off custom-priced products in front of other customers,
  // so we keep our own configuration and refresh it when the catalog changes.
  // Returns null when there is no catalog to pin, which leaves Stripe to fall
  // back to the account default.
  public getBillingPortalConfigurationId = async (returnUrl: string) => {
    const products = await this.getPortalUpdatableProducts();

    if (!products.length) return null;

    const signature = JSON.stringify(products);

    if (this.portalConfiguration?.signature === signature) {
      return this.portalConfiguration.id;
    }

    const features = {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      customer_update: {
        enabled: true,
        allowed_updates: ["email", "address"],
      },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products,
      },
    };

    const existing = await stripe.billingPortal.configurations.list({
      limit: 100,
      active: true,
    });
    const managed = existing?.data?.find(
      (portalConfig) =>
        portalConfig.metadata?.[MANAGED_PORTAL_CONFIGURATION_KEY] === "true",
    );

    const portalConfiguration = managed
      ? await stripe.billingPortal.configurations.update(managed.id, {
          features,
          default_return_url: returnUrl,
        })
      : await stripe.billingPortal.configurations.create({
          features,
          default_return_url: returnUrl,
          metadata: { [MANAGED_PORTAL_CONFIGURATION_KEY]: "true" },
        });

    this.portalConfiguration = { id: portalConfiguration.id, signature };

    return portalConfiguration.id;
  };

  // Creates a Stripe Billing Portal session so customers can self-manage their
  // subscription (view invoices, update payment methods, upgrade/downgrade, cancel).
  // Stripe is the source of truth; return_url brings the customer back to the web app.
  public createBillingPortalSession = async (
    customerId: string,
    returnUrl: string,
  ) => {
    const configurationId =
      await this.getBillingPortalConfigurationId(returnUrl);

    return stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(configurationId ? { configuration: configurationId } : {}),
    });
  };

  public createChargeWithSavedCard = async ({
    loggerInUserDetails,
    chargeData,
  }) => {
    const charge = await stripe.charges.create({
      amount: chargeData.amount,
      currency: chargeData.currency,
      customer: loggerInUserDetails.stripeCustomerId,
      source: chargeData.source,
    });
    return charge;
  };

  public createChargeWithOutSavedCard = async (chargeData) => {
    const charge = await stripe.charges.create({
      amount: chargeData.amount,
      currency: chargeData.currency,
      source: chargeData.token.id,
    });
    return charge;
  };

  public createChargeWithSource = async ({
    loggerInUserDetails,
    chargeData,
    source,
  }) => {
    const charge = await stripe.charges.create({
      amount: chargeData.amount,
      currency: chargeData.currency,
      customer: loggerInUserDetails.stripeCustomerId,
      source: source.id,
    });
    return charge;
  };

  public createSource = async ({ loggerInUserDetails, chargeData }) => {
    const customer = await stripe.customers.createSource(
      loggerInUserDetails.stripeCustomerId,
      {
        source: chargeData.token.id,
      },
    );
    return customer;
  };

  public listAllCards = async (loggerInUserDetails) => {
    const cardList = await stripe.customers.listSources(
      loggerInUserDetails.stripeCustomerId,
    );
    return cardList;
  };

  public updateCard = async ({ loggerInUserDetails, chargeData }) => {
    const card = await stripe.customers.updateSource(
      loggerInUserDetails.stripeCustomerId,
      chargeData.source,
      chargeData.newDetails,
    );

    return card;
  };

  public deleteCard = async ({ loggerInUserDetails, chargeData }) => {
    const confirmation = await stripe.customers.deleteSource(
      loggerInUserDetails.stripeCustomerId,
      chargeData.source,
    );
    return confirmation;
  };

  public createPayment = async ({ loggerInUserDetails, charge }) => {
    const payment = await Payment.create({
      amount: charge.amount,
      status: charge.status,
      stripeCustomerId: loggerInUserDetails.stripeCustomerId || 0,
      chargeId: charge.id,
      user: loggerInUserDetails._id || null,
      cardToken: charge.source.id,
      transactionId: charge.balance_transaction,
      email: loggerInUserDetails.email,
      currency: charge.currency,
      failureCode: charge.failure_code, // When status is success, it will be NULL.
      failureMessage: charge.failure_message, // When status is success, it will be NULL.
      gateWay: "stride",
    });
    return payment;
  };

  public constructEvent = async (body, stripeSignature) => {
    return stripe.webhooks.constructEvent(
      body,
      stripeSignature,
      config.STRIPE_WEBHOOK_SECRET,
    );
  };

  public getCardDetails = async (customerId, cardToken) => {
    return stripe.customers.retrieveSource(customerId, cardToken);
  };

  public cancelSubscription = async (subscriptionId: string) => {
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  };

  public addNewCard = async ({ customer_id, card_token }) => {
    return await stripe.customers.createSource(customer_id, {
      source: card_token,
    });
  };

  public updateDefaultCard = async ({ customer_id, card_id }) => {
    return await stripe.customers.update(customer_id, {
      default_source: card_id,
    });
  };

  public createRefundForCharge = async (refundData: {
    amount: number;
    charge: string;
    reason?: string;
  }) => {
    const penny = 100;
    const numberAfterDecimal = 2;
    const formattedAmount = parseInt(
      (refundData.amount * penny).toFixed(numberAfterDecimal),
    );
    const refund = await stripe.refunds.create({
      amount: formattedAmount,
      charge: refundData.charge,
      reason: refundData.reason,
    });
    return refund;
  };

  public createNewSubscription = async (
    customerId: string,
    priceId: string,
  ) => {
    try {
      // Create the subscription. Note we're expanding the Subscription's
      // latest invoice and that invoice's payment_intent
      // so we can pass it to the front end to confirm the payment
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [
          {
            price: priceId,
          },
        ],
        payment_behavior: "default_incomplete",
        payment_settings: {
          save_default_payment_method: "on_subscription",
        },
        expand: ["latest_invoice.payment_intent"],
      });

      return {
        subscriptionId: subscription.id,
        clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      };
    } catch (error) {
      return { error: { message: error.message } };
    }
  };

  public fetchAndDeleteExistingSubscriptions = async (customerId: string) => {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
    });

    await Promise.all(
      subscriptions.data.map((subscription) => {
        if (subscription.status === "incomplete") {
          stripe.subscriptions.cancel(subscription.id);
        }
      }),
    );
  };

  public fetchCurrentSubscriptions = async (customerId: string) => {
    const subscriptions = await stripe.subscriptions.list({
      customer: customerId,
      status: "active",
      expand: ["data.latest_invoice.payment_intent"],
    });
    return subscriptions?.data[0];
  };

  public getProductList = async () => {
    const products = await stripe.products.list({
      active: true,
      limit: 100,
    });

    return products?.data;
  };

  public getProductData = (productId: string) => {
    return stripe.products.retrieve(productId);
  };

  public getSubscriptionData = (subscriptionId: string) => {
    return stripe.subscriptions.retrieve(subscriptionId);
  };

  public isStatusActive = async (customerId: string) => {
    if (!customerId) return null;

    const subscription = await this.fetchCurrentSubscriptions(customerId);

    if (!subscription || !subscription.id) return null;

    return new Date() < new Date(subscription.current_period_end * 1000);
  };

  public getSubscriptionStatus = async (
    customerId: string,
    withSubId?: boolean,
  ) => {
    try {
      if (!customerId) return null;

      const subscription = await this.fetchCurrentSubscriptions(customerId);

      if (!subscription || !subscription.id) return null;

      const [product, subData] = await Promise.all([
        this.getProductData(subscription?.plan?.product),
        this.getSubscriptionData(subscription.id),
      ]);
      const expiry = new Date(subData.current_period_end * 1000);

      const obj: SubscriptionStatusType = {
        subscriptionPlan: product.name,
        subscriptionStatus:
          new Date() < expiry
            ? SUBSCRIPTION_STATUS.ACTIVE
            : SUBSCRIPTION_STATUS.EXPIRED,
        subscriptionBoughtFrom: SUBSCRIPTION_PURCHASE_STORE.STRIPE,
      };

      if (obj.subscriptionStatus != SUBSCRIPTION_STATUS.EXPIRED) {
        obj.subscriptionActiveUntil = expiry;
      }

      if (withSubId) {
        obj.subscriptionId = subData.id;
      }

      return obj;
    } catch (e) {
      return null;
    }
  };

  public cancelSubscriptionAfterBillingCycle = (subscriptionId: string) => {
    return stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  };

  public upgradeSubscription = async (subscriptionId, newPriceId) => {
    try {
      // Retrieve the subscription
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      // Update the subscription with a new price
      const updatedSubscription = await stripe.subscriptions.update(
        subscriptionId,
        {
          items: [
            {
              id: subscription.items.data[0].id,
              price: newPriceId, // The ID of the new price or plan
            },
          ],
          // You can also set `proration_behavior` to 'create_prorations' to handle billing for the current cycle
          proration_behavior: "create_prorations", // Adjust billing for the current cycle
        },
      );

      return updatedSubscription;
    } catch (error) {
      console.error("Failed to upgrade subscription:", error);
      throw error;
    }
  };

  public downgradeSubscription = async (subscriptionId, newPriceId) => {
    try {
      // Retrieve the subscription
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      // Update the subscription with a new price
      const updatedSubscription = await stripe.subscriptions.update(
        subscriptionId,
        {
          items: [
            {
              id: subscription.items.data[0].id,
              price: newPriceId, // The ID of the new price or plan
            },
          ],
          // You can also set `proration_behavior` to 'create_prorations' to handle billing for the current cycle
          proration_behavior: "create_prorations", // No immediate billing, change takes effect at the end of the cycle
        },
      );

      return updatedSubscription;
    } catch (error) {
      console.error("Failed to upgrade subscription:", error);
      throw error;
    }
  };
}
export const stripeService = new StripeService();
