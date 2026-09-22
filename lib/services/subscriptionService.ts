import { SUBSCRIPTION_STATUS } from "../utils/enums/enums";
import { UserHelper } from "../routes/user/helper";
import { RevenueCatService } from "./revenueCatService";
import { stripeService } from "./stripeService";
import { CompanyHelpers } from "../routes/company/helpers";
import { subscriptionPlanUsers } from "../utils/constants/constants";
import { ISeatAvailability } from "../utils/interfaces/companyMember";

export class SubscriptionService {
  public static getSubscriptionData = async (companyId) => {
    let subscriptionStatus: any = {
      subscriptionStatus: SUBSCRIPTION_STATUS.NO_SUBSCRIPTION,
    };

    if (!companyId) return subscriptionStatus;
    const [admin, companyMembers] = await await Promise.all([
      CompanyHelpers.getCompanyAdminId(companyId),
      CompanyHelpers.getCompanyMembers([companyId]),
    ]);

    let maxAllowedUsers = 2;

    if (admin?.userId) {
      const adminUser = await UserHelper.findOne({ _id: admin.userId });
      const [revenueCat, stripe] = await Promise.all([
        RevenueCatService.getSubScriptionStatus(admin?.userId, true, true),
        stripeService.getSubscriptionStatus(adminUser.stripeCustomerId),
      ]);

      if (stripe) {
        subscriptionStatus = stripe;
        maxAllowedUsers = Math.max(maxAllowedUsers, admin.teamLimit);
      } else subscriptionStatus = revenueCat;
    }

    let companyMembersLimitExceded = false;
    maxAllowedUsers = Math.max(
      maxAllowedUsers,
      subscriptionPlanUsers(
        subscriptionStatus?.subscriptionPlan?.split(/[_-]/)?.[0],
      ),
    );

    if (maxAllowedUsers < companyMembers.length) {
      companyMembersLimitExceded = true;
    }

    return {
      ...subscriptionStatus,
      companyMembersLimitExceded,
      maxAllowedUsers,
      activeMembersCount: companyMembers.length,
    };
  };

  // Whether the company can take on one more active member. Used when
  // re-enabling a deactivated member so the plan's seat cap is not exceeded.
  public static getSeatAvailability = async (
    companyId,
  ): Promise<ISeatAvailability> => {
    // Defaults cover the no-company early return in getSubscriptionData, which
    // deliberately resolves to "no seats available".
    const { maxAllowedUsers = 0, activeMembersCount = 0 } =
      await this.getSubscriptionData(companyId);

    return {
      maxAllowedUsers,
      activeMembersCount,
      hasSeatAvailable: activeMembersCount < maxAllowedUsers,
    };
  };

  public static isSubscriptionActive = async (companyId) => {
    const subscriptionStatus = await this.getSubscriptionData(companyId);
    return (
      subscriptionStatus.subscriptionStatus == SUBSCRIPTION_STATUS.ACTIVE &&
      !subscriptionStatus.companyMembersLimitExceded
    );
  };
}
