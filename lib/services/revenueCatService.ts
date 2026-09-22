import { config } from "../utils/configuration/config";
import { httpClientConfig } from "../utils/interfaces/httpClientConfig";
import { HttpClient } from "./httpClient";
import {
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_PURCHASE_STORE,
  SUBSCRIPTION_STATUS,
} from "../utils/enums/enums";
import { Types } from "mongoose";

export class RevenueCatService {
  public static readonly REVENUECAT_API_KEY_V1: string =
    config.REVENUECAT_API_KEY_V1;
  public static readonly subscription: string =
    "https://api.revenuecat.com/v1/subscribers/";

  public static getSubScriptionData = async (userId: string): Promise<any> => {
    const requestConfig: httpClientConfig = {
      method: "GET",
      url: this.subscription + userId,
      headers: {
        Authorization: "Bearer " + this.REVENUECAT_API_KEY_V1,
      },
    };

    const data = await HttpClient.Request(requestConfig);
    return data;
  };

  public static getSubScriptionStatus = async (
    userId: Types.ObjectId,
    withTime?: boolean,
    withPlan?: boolean,
  ): Promise<any> => {
    if (!userId) {
      return null;
    }
    const response = await this.getSubScriptionData(userId.toString());

    let status = SUBSCRIPTION_STATUS.NO_SUBSCRIPTION;
    let subscriptionActiveUntil = null;
    let subscriptionPlan = null;
    if (response?.subscriber?.subscriptions) {
      const subscriptions = response.subscriber.subscriptions;
      const currentDate = new Date();
      for (const key of SUBSCRIPTION_PLANS) {
        if (!subscriptions[key]) continue;
        const expiry = new Date(subscriptions[key].expires_date);
        const gracePeriod = new Date(
          subscriptions[key].grace_period_expires_date,
        );
        if (currentDate < expiry) {
          status = SUBSCRIPTION_STATUS.ACTIVE;
          subscriptionActiveUntil = expiry;
          subscriptionPlan = key;
          break;
        } else if (currentDate < gracePeriod) {
          status = SUBSCRIPTION_STATUS.GRACE_PERIOD;
        } else {
          status = SUBSCRIPTION_STATUS.EXPIRED;
        }
      }
    }
    if (withTime || withPlan) {
      return {
        subscriptionStatus: status,
        subscriptionActiveUntil,
        subscriptionPlan,
        subscriptionBoughtFrom: SUBSCRIPTION_PURCHASE_STORE.REVENUECAT,
      };
    }
    return status;
  };
}
