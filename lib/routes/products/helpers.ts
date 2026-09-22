import { Products } from "../../db";
import {
  ObjectId,
  createFacetPipeline,
} from "../../utils/helpers/commonHelper";
import { ProductType } from "../../utils/interfaces/schemaInterface";
import { PaginatedSearchQuery } from "../../utils/interfaces/query";
export class ProductsHelpers {
  public static findOne = async (id: string) => {
    return Products.findOne({ _id: ObjectId(id) });
  };

  public static findAll = async (
    query: PaginatedSearchQuery,
    userId: string,
  ) => {
    const page = Number(query.page) || 1;
    const limit = Number(query.pageSize) || 50;
    const skips = (page - 1) * limit;
    const searchValue = query.searchValue;
    const sortBy = query.sortBy === "true" ? 1 : -1;
    const facetPipeline = createFacetPipeline(page, skips, limit);
    return Products.aggregate([
      {
        $match:
          searchValue && searchValue.length
            ? {
                title: { $regex: searchValue, $options: "i" },
                status: "ACTIVE",
                createdBy: userId,
              }
            : { status: "ACTIVE", createdBy: userId },
      },
      {
        $sort: {
          price: sortBy,
        },
      },
      ...facetPipeline,
    ]);
  };

  public static findAndUpdate = async (
    id: string,
    userId: string,
    update: ProductType,
  ) => {
    return Products.findOneAndUpdate(
      { $and: [{ _id: id, createdBy: userId }] },
      { ...update, createdBy: userId },
      { returnDocument: "after" },
    );
  };

  public static create = async (document: ProductType) => {
    return Products.create(document);
  };

  public static softDelete = async (id: string, userId: string) => {
    return Products.findOneAndUpdate(
      { $and: [{ _id: id, createdBy: userId }] },
      { $set: { status: "DELETED" } },
      { returnDocument: "after" },
    );
  };
}
