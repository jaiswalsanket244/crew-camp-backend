import { findModel } from "../../db/index";

export class AutoCompleteHelpers {
  public static findAll = async (query) => {
    try {
      const collectionName = query.collectionName;
      let field = query.field;
      const fieldValue = query.value;

      const modifyName = {};
      field = modifyName[field] ? modifyName[field] : field;

      const groupQuery = { $group: { _id: "$" + field } };

      const regexSearchQuery = (key, value) => {
        return { [key]: { $regex: "_*" + value + "_*", $options: "i" } };
      };
      const matchQuery = {
        $match: regexSearchQuery(field, fieldValue),
      };

      const projectQuery = {
        $project: {
          _id: 0,
          ["name"]: "$_id",
        },
      };

      const aggregatePipeline = [matchQuery, groupQuery, projectQuery];
      const data = await findModel(collectionName).aggregate(aggregatePipeline);
      return data;
    } catch (error) {
      console.log("error: ", error);
    }
  };
}
