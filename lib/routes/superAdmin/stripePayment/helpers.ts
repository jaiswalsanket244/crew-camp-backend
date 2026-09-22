import { PaymentHelpers } from "../../admin/payments/helpers";
import { config } from "../../../utils/configuration/config";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);

export class StripePaymentHelpers {
  public static getAllChargesSuperAdmin = async (
    query: PaginatedSearchQuery,
  ) => {
    const page = query.page;
    const filter = query.filter;
    const searchValue = query.searchValue;

    let searchQuery = "";
    const queryArray = [];

    if (filter?.status) {
      switch (filter?.status) {
        case "Refunded":
          queryArray.push('refunded:"true"');
          break;
        case "Succeeded":
          queryArray.push('status:"succeeded"');
          break;
        default:
          queryArray.push('refunded:"false"');
          break;
      }
    }

    if (filter?.amount) {
      const min = filter?.amount?.min;
      const max = filter?.amount?.max;
      if (min) {
        queryArray.push(`amount>=${min * 100}`);
      }
      if (max) {
        queryArray.push(`amount<=${max * 100}`);
      }
    }

    if (filter?.revenue && !filter?.amount) {
      const min = filter?.revenue?.min;
      const max = filter?.revenue?.max;
      if (min) {
        queryArray.push(`amount>=${min * 5 * 100}`);
      }
      if (max) {
        queryArray.push(`amount<=${max * 5 * 100}`);
      }
    }

    if (filter?.created) {
      const from = filter?.created?.from;
      const to = filter?.created?.to;
      if (from) {
        const startDate = new Date(from);
        const startTimestamp = Math.round(startDate.getTime() / 1000);
        queryArray.push(`created>=${startTimestamp}`);
      }
      if (to) {
        const endDate = new Date(to);
        const endTimestamp = Math.round(endDate.getTime() / 1000);
        queryArray.push(`created<=${endTimestamp}`);
      }
    } else {
      const currentDate = Math.round(new Date().getTime() / 1000);
      searchQuery += `created<${currentDate}`;
    }

    if (searchValue) {
      const sellerySearchQuery = `metadata['sellerName']:'${searchValue}'`;
      queryArray.push(sellerySearchQuery);
    }

    queryArray.forEach((item, index) => {
      if (filter?.created && index === 0) {
        searchQuery += item;
      } else {
        searchQuery += " AND " + item;
      }
    });

    const chargeQuery: any = {
      query: searchQuery,
      expand: [
        "data.customer",
        "data.transfer_data.destination",
        "data.balance_transaction",
      ],
    };
    if (page) {
      chargeQuery.page = page;
    }
    const charges = await stripe.charges.search(chargeQuery);
    const balance = await stripe.balance.retrieve();

    return {
      balance,
      charges,
    };
  };

  public static getAllSellersSuperAdmin = async (query) => {
    const chargeParameter: any = {
      created: {},
      limit: 100,
    };

    if (query?.next) {
      chargeParameter.starting_after = query.next;
    }

    if (query?.prev) {
      chargeParameter.ending_before = query.prev;
    }

    if (query?.email) {
      chargeParameter.email = query.email;
    }

    if (query?.created) {
      const from = query?.created?.from;
      const to = query?.created?.to;
      if (from) {
        const startDate = new Date(from);
        const startTimestamp = Math.round(startDate.getTime() / 1000);
        chargeParameter.created["gte"] = startTimestamp;
      }
      if (to) {
        const endDate = new Date(to);
        const endTimestamp = Math.round(endDate.getTime() / 1000);
        chargeParameter.created["lte"] = endTimestamp;
      }
    }

    let sellers = await stripe.accounts.list(chargeParameter);
    sellers = sellers.data;

    if (query?.ChargesEnabled) {
      if (query?.ChargesEnabled === "True") {
        sellers = sellers.filter((item) => item.charges_enabled);
      } else if (query?.ChargesEnabled === "False") {
        sellers = sellers.filter((item) => !item.charges_enabled);
      }
    }
    if (query?.PayoutsEnabled) {
      if (query?.PayoutsEnabled === "True") {
        sellers = sellers.filter((item) => item.payouts_enabled);
      } else if (query?.PayoutsEnabled === "False") {
        sellers = sellers.filter((item) => !item.payouts_enabled);
      }
    }
    return sellers;
  };

  public static getAllSellerCharges = async (
    stripeAccountId: string,
    query,
  ) => {
    const chargesPromise = PaymentHelpers.getSellerCharges(
      stripeAccountId,
      query,
    );
    const balancePromise =
      PaymentHelpers.getSellerStripeBalance(stripeAccountId);
    const [charges, balance] = await Promise.all([
      chargesPromise,
      balancePromise,
    ]);

    return { charges: charges, balance: balance };
  };

  public static getAllPayouts = async (query) => {
    const filter = query?.filter;
    const payoutParameter = {
      limit: 20,
      expand: ["data.destination", "data.balance_transaction"],
      created: {},
      amount: {},
    };

    if (filter?.status) {
      payoutParameter["status"] = filter?.status;
    }

    if (filter?.amount) {
      const min = filter?.amount?.min;
      const max = filter?.amount?.max;
      if (min) {
        payoutParameter.amount["gte"] = min * 100;
      }
      if (max) {
        payoutParameter.amount["lte"] = max * 100;
      }
    }

    if (filter?.created) {
      const from = filter?.created?.from;
      const to = filter?.created?.to;
      if (from) {
        const startDate = new Date(from);
        const startTimestamp = Math.round(startDate.getTime() / 1000);
        payoutParameter.created["gte"] = startTimestamp;
      }
      if (to) {
        const endDate = new Date(to);
        const endTimestamp = Math.round(endDate.getTime() / 1000);
        payoutParameter.created["lte"] = endTimestamp;
      }
    }

    if (query?.next) {
      payoutParameter["starting_after"] = query.next;
    }

    if (query?.prev) {
      payoutParameter["ending_before"] = query.prev;
    }
    const payouts = await stripe.payouts.list(payoutParameter);
    const balance = await stripe.balance.retrieve();
    return {
      payouts,
      balance,
    };
  };
  public static createPayout = async (amount) => {
    return stripe.payouts.create({
      amount: amount * 100,
      currency: "usd",
    });
  };
}
