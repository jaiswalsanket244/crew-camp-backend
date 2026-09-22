import { Company, CompanyMember, InvitedUsers, User } from "../../../db";
import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { CompanyType } from "../../../utils/interfaces/schemaInterface";
import {
  ObjectId,
  createFacetPipeline,
} from "../../../utils/helpers/commonHelper";
import { CURRENT_STATUS, USER_ROLE } from "../../../utils/enums/enums";

export class CompanyHelpers {
  public static getCompanies = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;

    const matchObj: any = {};

    if (query.searchValue) {
      matchObj.$text = { $search: query.searchValue };
    }

    if (query.filter?.date) {
      const dateQuery = {
        createdAt: {},
      };

      if (query.filter?.date?.from) {
        dateQuery.createdAt["$gte"] = new Date(query.filter.date.from);
      }

      if (query.filter?.date?.to) {
        dateQuery.createdAt["$lte"] = new Date(query.filter.date.to);
      }

      if (Object.keys(dateQuery).length > 0) {
        matchObj.$and = dateQuery;
      }
    }
    const facetPipeline = createFacetPipeline(page, skips, limit);

    return Company.aggregate([
      { $match: matchObj },
      { $sort: { createdAt: -1 } },
      { $skip: skips },
      { $limit: limit },
      ...facetPipeline,
    ]);
  };

  public static getCompanyUsers = async (
    companyId: string,
    query: PaginatedSearchQuery,
  ) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const matchObj: any = { companyId: ObjectId(companyId) };
    if (searchValue.length) {
      matchObj.$text = { $search: searchValue };
    }
    const facetPipeline = createFacetPipeline(page, skips, limit);

    return User.aggregate([
      {
        $match: matchObj,
      },
      ...facetPipeline,
    ]);
  };

  public static updateCompany = async (id: string, update: CompanyType) => {
    return Company.findByIdAndUpdate(id, update);
  };

  public static getCompanyDetails = async (id: string) => {
    return Company.findById(id);
  };

  public static changeUserRole = async (
    userId: string,
    companyId: string,
    roles: string,
  ) => {
    return User.updateOne({ _id: userId, companyId }, { roles });
  };
}
