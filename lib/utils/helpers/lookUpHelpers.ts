function getOnlyBasicUserDetails() {
  return [
    {
      $lookup: {
        from: "users",
        localField: "userId",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              "name.first": 1,
              "name.last": 1,
              profileImage: 1,
            },
          },
        ],
        as: "userInfo",
      },
    },
    {
      $addFields: {
        profileImage: { $arrayElemAt: ["$userInfo.profileImage", 0] },
        userName: {
          $concat: [
            { $arrayElemAt: ["$userInfo.name.first", 0] },
            " ",
            { $arrayElemAt: ["$userInfo.name.last", 0] },
          ],
        },
      },
    },
  ];
}

function getPostNote() {
  return [
    {
      $lookup: {
        from: "posts",
        localField: "postId",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              note: 1,
              totalFiles: 1,
              createdAt: 1,
            },
          },
        ],
        as: "postInfo",
      },
    },
  ];
}

function getProjectNamePipeline() {
  return [
    {
      $lookup: {
        from: "projects",
        localField: "projectId",
        foreignField: "_id",
        pipeline: [
          {
            $project: {
              name: 1,
            },
          },
        ],
        as: "projectInfo",
      },
    },
  ];
}

export { getOnlyBasicUserDetails, getPostNote, getProjectNamePipeline };
