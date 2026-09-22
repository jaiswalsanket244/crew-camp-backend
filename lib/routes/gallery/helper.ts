import { Gallery, GalleryFiles } from "../../db";
import { getUserNamePipeline } from "../../utils/helpers/commonHelper";
import { IGalleryFiles } from "../../utils/interfaces/gallery";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";

export class GalleryHelper {
  public static createGallery = async (files: IGalleryFiles[], userId) => {
    const gallery = await Gallery.create({ userId });

    await GalleryFiles.insertMany(
      files.map((file) => {
        const newFile = { ...file, galleryId: gallery._id };
        delete newFile._id;
        return newFile;
      }),
    );

    return gallery;
  };

  public static findFilesWithTheirData = (galleryId: ObjectIdType) => {
    const userNamePipeline = getUserNamePipeline();
    const pipeline = [
      {
        $match: {
          galleryId,
        },
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "posts",
          localField: "postId",
          foreignField: "_id",
          as: "post",
        },
      },
      {
        $project: {
          files: 1,
          postCreatedAt: {
            $arrayElemAt: ["$post.createdAt", 0],
          },
          description: {
            $arrayElemAt: ["$post.note", 0],
          },
          userName: 1,
          profileImage: 1,
        },
      },
      {
        $unwind: {
          path: "$files",
        },
      },
    ];
    return GalleryFiles.aggregate(pipeline);
  };

  public static getGalleryCreaterData = (galleryId: ObjectIdType) => {
    const userNamePipeline = getUserNamePipeline();

    return Gallery.aggregate([
      {
        $match: {
          _id: galleryId,
        },
      },
      ...userNamePipeline,
      {
        $lookup: {
          from: "companymembers",
          let: { galleryUserId: "$userId" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$userId", "$$galleryUserId"] },
                status: "ACTIVE",
              },
            },
          ],
          as: "companyMemberInfo",
        },
      },
      {
        $lookup: {
          from: "companies",
          localField: "companyMemberInfo.companyId",
          foreignField: "_id",
          as: "companyInfo",
        },
      },
      {
        $addFields: {
          companyLogo: {
            $arrayElemAt: ["$companyInfo.companyLogo", 0],
          },
        },
      },
    ]);
  };
}
