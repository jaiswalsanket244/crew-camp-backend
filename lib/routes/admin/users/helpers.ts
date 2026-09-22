import { PaginatedSearchQuery } from "../../../utils/interfaces/query";
import { User as users } from "../../../db";
import {
  ObjectId,
  createFacetPipeline,
} from "../../../utils/helpers/commonHelper";
export class AdminUsersHelpers {
  public static findAll = async (query: PaginatedSearchQuery) => {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 10;
    const filter = query.filter;
    const dateFilter = filter?.date;
    const searchValue = query.searchValue;
    const skips = (page - 1) * pageSize;
    const companyId = query.companyId;
    const dateQuery = dateFilter
      ? {
          createdAt: {
            ...(dateFilter.from ?? { $gte: new Date(dateFilter.from) }),
            ...(dateFilter.to ?? { $lte: new Date(dateFilter.to) }),
          },
        }
      : undefined;

    const roleQuery = filter?.role ? { "roles.$eq": filter.role } : undefined;

    const andQuery = [];

    if (dateQuery) {
      andQuery.push(dateQuery);
    }
    if (roleQuery) {
      andQuery.push(roleQuery);
    }

    const facetPipeline = createFacetPipeline(page, skips, pageSize);

    return users.aggregate([
      {
        $match: {
          companyId: ObjectId(companyId),
          ...(andQuery.length > 0 ? { $and: andQuery } : {}),
          ...(searchValue
            ? {
                $text: { $search: searchValue },
              }
            : {}),
        },
      },
      ...facetPipeline,
    ]);
  };

  public static findOne = async (id: string) => {
    return users.findById(id);
  };
}
