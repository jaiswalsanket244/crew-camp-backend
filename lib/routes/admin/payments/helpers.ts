import { Payment, Refund } from "../../../db";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { config } from "../../../utils/configuration/config";
import * as dayjs from "dayjs";
import { RefundData } from "../../../utils/interfaces/schemaInterface";
import { createFacetPipeline } from "../../../utils/helpers/commonHelper";

interface PayementsQuery extends PaginatedSearchQuery {
  dateFrom?: string;
  dateTo?: string;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stripe = require("stripe")(config.STRIPE_SECRET_KEY);

export class PaymentHelpers {
  public static getAllPayments = async (query: PayementsQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const matchObj: any = {};
    if (searchValue) {
      matchObj.$text = { $search: searchValue };
    }
    if (query.dateFrom && query.dateTo) {
      matchObj.createdAt = {
        $gte: new Date(query.dateFrom),
        $lt: new Date(query.dateTo),
      };
    }
    const facetPipeline = createFacetPipeline(page, skips, limit);

    const data = await Payment.aggregate([
      {
        $match: matchObj,
      },
      {
        $lookup: {
          from: "users",
          localField: "user",
          foreignField: "_id",
          as: "userData",
        },
      },
      {
        $lookup: {
          from: "refunds",
          localField: "_id",
          foreignField: "paymentId",
          as: "refunds",
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      ...facetPipeline,
    ]);
    const processedData = data[0].data.map((item) => {
      item.amount = (item.amount / 100).toFixed(2);
      item.userName = `${item.userData[0].name.first} ${item.userData[0].name.last}`;
      item.epochTime = dayjs(item.createdAt).valueOf();
      delete item.userData;
      item.refunds.forEach((refund) => {
        refund.amount = (refund.amount / 100).toFixed(2);
        refund.epochTime = dayjs(refund.createdAt).valueOf();
      });
      return item;
    });

    data[0].data = processedData;

    return data;
  };

  public static getPaymentById = async (id: string) => {
    return Payment.findById(id);
  };

  public static createRefund = async (refundData: RefundData) => {
    const refundObj = {
      ...refundData,
      refundId: refundData.id,
    };

    return Refund.create(refundObj);
  };

  public static getSellerCharges = async (
    stripeAccountId: string,
    query: PaginatedSearchQuery,
  ) => {
    const filter = query?.filter;
    const chargeParameter: any = {
      expand: [
        "data.customer",
        "data.transfer_data.destination",
        "data.balance_transaction",
        "total_count",
      ],
      amount: {},
      created: {},
    };

    if (filter?.amount) {
      const { min, max } = filter.amount;
      if (min !== undefined) {
        chargeParameter.amount = { ...chargeParameter.amount, gte: min * 100 };
      }
      if (max !== undefined) {
        chargeParameter.amount = { ...chargeParameter.amount, lte: max * 100 };
      }
    }

    if (filter?.created) {
      const { from, to } = filter.created;
      if (from) {
        chargeParameter.created = {
          ...chargeParameter.created,
          gte: Math.round(new Date(from).getTime() / 1000),
        };
      }
      if (to) {
        chargeParameter.created = {
          ...chargeParameter.created,
          lte: Math.round(new Date(to).getTime() / 1000),
        };
      }
    }

    return stripe.charges.list(chargeParameter, {
      stripeAccount: stripeAccountId,
    });
  };

  public static getSellerPayouts = async (
    stripeAccountId: string,
    query: any,
  ) => {
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
    return stripe.payouts.list(payoutParameter, {
      stripeAccount: stripeAccountId,
    });
  };

  public static getSellerStripeBalance = async (stripeAccountId: string) => {
    return stripe.balance.retrieve({
      stripeAccount: stripeAccountId,
    });
  };

  public static createPayout = async (
    amount: number,
    stripeAccountId: string,
  ) => {
    return stripe.payouts.create(
      {
        amount: amount * 100,
        currency: "usd",
      },
      { stripeAccount: stripeAccountId },
    );
  };
}
