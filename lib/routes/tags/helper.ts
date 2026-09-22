import { Tags } from "../../db";
import { CURRENT_TAGS, TAGS_FOR } from "../../utils/enums/enums";
import { ObjectId } from "../../utils/helpers/commonHelper";
import { ProjectHelper } from "../projects/helper";

export class TagsHelper {
  public static create = async (companyId, body) => {
    const { tag, color, tagFor } = body;
    return Tags.create({
      tag,
      color,
      companyId,
      tagFor,
    });
  };

  public static getDefault = async (tagFor: string) => {
    return Tags.find(
      { type: CURRENT_TAGS.DEFAULT, tagFor },
      { tag: 1, color: 1, type: 1 },
    );
  };

  public static getCustom = async (companyId: string, tagFor: string) => {
    if (!companyId) return [];
    return Tags.find(
      { type: CURRENT_TAGS.CUSTOM, companyId: ObjectId(companyId), tagFor },
      { tag: 1, color: 1, type: 1 },
    );
  };

  public static update = async (_id: string, updateFields) => {
    return Tags.findByIdAndUpdate(ObjectId(_id), updateFields);
  };

  public static delete = async (_id: string) => {
    return Tags.findByIdAndDelete(ObjectId(_id));
  };

  public static getProjectsTags = async (projectId: string) => {
    const { tags } = await ProjectHelper.getProjectData(projectId);
    return Tags.find(
      { _id: { $in: tags }, tagFor: TAGS_FOR.PROJECT },
      { tag: 1, color: 1, type: 1 },
    );
  };
}
