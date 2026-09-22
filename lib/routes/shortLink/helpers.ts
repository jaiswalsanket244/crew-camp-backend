import { Urls } from "../../db";
import { config } from "../../utils/configuration/config";

export class ShortLinkHelpers {
  public static getLink = async (id: string) => {
    return await Urls.findById(id);
  };

  public static createLink = async (document: { url: string }) => {
    const result = await Urls.findOneAndUpdate(
      document,
      {},
      {
        upsert: true,
        new: true,
      },
    );
    return `${config.WEB_URL}/s/${result._id}`;
  };
}
