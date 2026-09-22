import { Types } from "mongoose";
import {
  CompanyMember,
  Crews,
  CrewsMembers,
  CrewsProjects,
  Project,
} from "../../db";
import { getUserNamePipeline } from "../../utils/helpers/commonHelper";
import { isAdminUser, isManagerAndAbove } from "../../utils/helpers/users";
import { ProjectHelper } from "../projects/helper";

type mongoId = Types.ObjectId;
export class CrewsHelper {
  public static getAllCrewsData = async (
    companyId: mongoId,
    query: any,
    currentUserRole?: string,
  ) => {
    const { page, pageSize, skips, searchValue } = query;
    const crewsMatch: any = {
      status: "ACTIVE",
      companyId: companyId.toString(),
    };

    if (searchValue && searchValue.length) {
      crewsMatch.name = {
        $regex: searchValue,
        $options: "i",
      };
    }

    const result = await Crews.aggregate([
      { $match: crewsMatch },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            {
              $lookup: {
                from: "crewsmembers",
                localField: "_id",
                foreignField: "crewId",
                pipeline: [
                  { $match: { status: "ACTIVE" } },
                  ...getUserNamePipeline("userId"),
                  {
                    $project: {
                      userId: 1,
                      userName: 1,
                      profileImage: 1,
                      userRole: 1,
                      roles: 1,
                    },
                  },
                ],
                as: "members",
              },
            },
            {
              $lookup: {
                from: "crewsprojects",
                localField: "_id",
                foreignField: "crewId",
                as: "projectsData",
              },
            },
            {
              $addFields: {
                projectIds: "$projectsData.projectId",
                memberCount: { $size: "$members" },
                projectCount: { $size: "$projectsData" },
              },
            },
            {
              $project: {
                projectsData: 0,
              },
            },
            { $sort: { createdAt: -1 } },
            { $skip: skips },
            { $limit: pageSize },
          ],
        },
      },
    ]);

    const crews = result[0]?.data || [];
    const totalCount = result[0]?.metadata[0]?.total || 0;

    // Managers and admins get full crew management parity (CRE-175):
    // crew management is gated purely by role, not by member rank.
    if (currentUserRole && crews.length > 0) {
      const canManage = isManagerAndAbove(currentUserRole);
      for (const crew of crews) {
        crew.changeAccess = canManage;
      }
    }

    return {
      crews,
      page,
      pageSize,
      totalCount,
    };
  };

  public static getCrewList = async (companyId: mongoId, query: any) => {
    const { page, pageSize, skips, searchValue } = query;
    const crewsMatch: any = {
      status: "ACTIVE",
      companyId: companyId.toString(),
    };

    if (searchValue && searchValue.length) {
      crewsMatch.name = {
        $regex: searchValue,
        $options: "i",
      };
    }

    const result = await Crews.aggregate([
      { $match: crewsMatch },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            {
              $lookup: {
                from: "crewsmembers",
                localField: "_id",
                foreignField: "crewId",
                pipeline: [{ $match: { status: "ACTIVE" } }],
                as: "members",
              },
            },
            {
              $project: {
                _id: 1,
                name: 1,
                createdAt: 1,
                totalMembers: { $size: "$members" },
              },
            },
            { $sort: { createdAt: -1 } },
            { $skip: skips },
            { $limit: pageSize },
          ],
        },
      },
    ]);

    const crews = result[0]?.data || [];
    const totalCount = result[0]?.metadata[0]?.total || 0;

    return {
      crews,
      page,
      pageSize,
      totalCount,
    };
  };

  public static getCrewDetails = async (
    crewId: mongoId,
    companyId: mongoId,
    query: any,
  ) => {
    const { page, pageSize, skips, searchValue } = query;

    // Convert crewId to ObjectId
    const crewObjectId = new Types.ObjectId(crewId);

    // Build member match query with ObjectId
    const memberMatch: any = { crewId: crewObjectId, status: "ACTIVE" };

    // Build member data pipeline
    const memberDataPipeline: any[] = [];

    // Add getUserNamePipeline
    memberDataPipeline.push(...getUserNamePipeline("userId"));

    // Add search filter if provided
    if (searchValue && searchValue.length) {
      memberDataPipeline.push({
        $match: {
          userName: {
            $regex: searchValue,
            $options: "i",
          },
        },
      });
    }

    // Add projection
    memberDataPipeline.push({
      $project: {
        userId: 1,
        userName: 1,
        profileImage: 1,
        userRole: 1,
        roles: 1,
        userContactInfo: 1,
      },
    });

    // Get crew and members data in parallel
    const [crew, membersResult] = await Promise.all([
      Crews.findOne({
        _id: crewObjectId,
        status: "ACTIVE",
        companyId: companyId.toString(),
      }),
      CrewsMembers.aggregate([
        { $match: memberMatch },
        {
          $facet: {
            metadata: [
              ...getUserNamePipeline("userId"),
              ...(searchValue && searchValue.length
                ? [
                    {
                      $match: {
                        userName: {
                          $regex: searchValue,
                          $options: "i",
                        },
                      },
                    },
                  ]
                : []),
              { $count: "total" },
            ],
            data: [
              ...memberDataPipeline,
              { $skip: skips },
              { $limit: pageSize },
            ],
          },
        },
      ]),
    ]);

    if (!crew) {
      throw new Error("Crew not found");
    }

    const members = membersResult[0]?.data || [];
    const filteredCount = membersResult[0]?.metadata[0]?.total || 0;

    return {
      crew: {
        _id: crew._id,
        name: crew.name,
        createdAt: crew.createdAt,
        status: crew.status,
      },
      members,
      pagination: {
        page,
        pageSize,
        totalMembers: filteredCount,
        totalPages: Math.ceil(filteredCount / pageSize),
      },
    };
  };

  public static createCrew = async (
    data: any,
    userId: mongoId,
    companyId: mongoId,
  ) => {
    const { name, userIds } = data;

    // Verify all userIds exist in the company
    const validUsers = await CompanyMember.find({
      userId: { $in: userIds },
      companyId,
      status: "ACTIVE",
    });

    if (validUsers.length !== userIds.length) {
      throw new Error("Some user IDs are not valid company members");
    }

    // Create the crew
    const crew = await Crews.create({
      name,
      status: "ACTIVE",
      companyId: companyId.toString(),
    });

    // Create crew members
    const crewMembers = userIds.map((uid: any) => ({
      crewId: crew._id,
      userId: uid,
      status: "ACTIVE",
    }));

    await CrewsMembers.insertMany(crewMembers);

    return crew;
  };

  public static updateCrew = async (
    crewId: mongoId,
    companyId: mongoId,
    update: any,
  ) => {
    const { name } = update;

    const crew = await Crews.findOne({
      _id: crewId,
      companyId: companyId.toString(),
    });
    if (!crew) {
      throw new Error("Crew not found");
    }

    if (name !== undefined && (!name || !name.trim())) {
      throw new Error("Crew name is required and cannot be empty");
    }

    return Crews.findByIdAndUpdate(crewId, { $set: update }, { new: true });
  };

  public static deleteCrew = async (crewId: mongoId, companyId: mongoId) => {
    const crew = await Crews.findOne({
      _id: crewId,
      companyId: companyId.toString(),
    });

    if (!crew) {
      throw new Error("Crew not found");
    }

    const currentMembers = await CrewsMembers.find({
      crewId,
      status: "ACTIVE",
    });

    const currentUserIds = currentMembers.map((m) => m.userId.toString());

    const crewProjects = await CrewsProjects.find({ crewId });
    const projectIds = crewProjects.map((cp) => cp.projectId);

    let removedFromProjects = 0;

    // Remove users from crew and related projects
    const leaveCrewPromises = currentUserIds.map((userId) =>
      this.leaveCrew(new Types.ObjectId(userId), crewId),
    );

    const leaveProjectPromises: Promise<any>[] = [];
    if (projectIds.length > 0) {
      for (const userId of currentUserIds) {
        for (const projectId of projectIds) {
          leaveProjectPromises.push(
            ProjectHelper.leaveProject(userId, projectId),
          );
        }
      }
    }

    await Promise.all([...leaveCrewPromises, ...leaveProjectPromises]);
    removedFromProjects = leaveProjectPromises.length;

    const updatedCrew = await Crews.findByIdAndUpdate(
      crewId,
      { $set: { status: "INACTIVE" } },
      { new: true },
    );

    //  Return summary
    return {
      message: "Crew deleted successfully",
      removed: currentUserIds.length,
      removedFromProjects,
      updatedCrew,
    };
  };

  public static updateMembers = async (
    crewId: mongoId,
    userIds: mongoId[],
    companyId: mongoId,
  ) => {
    // Verify the crew exists
    const crew = await Crews.findOne({
      _id: crewId,
      companyId: companyId.toString(),
    });
    if (!crew) {
      throw new Error("Crew not found");
    }

    // Validate that at least 1 userId is provided
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      throw new Error("At least one user ID is required");
    }

    // Get current crew members
    const currentMembers = await CrewsMembers.find({
      crewId,
      status: "ACTIVE",
    });

    const currentUserIds = currentMembers.map((m) => m.userId.toString());

    // Verify all userIds exist in the company
    const validUsers = await CompanyMember.find({
      userId: { $in: userIds },
      companyId,
      status: "ACTIVE",
    });

    if (validUsers.length !== userIds.length) {
      throw new Error("Some user IDs are not valid company members");
    }

    const newUserIds = userIds.map((id) => id.toString());

    // Find users to add and remove
    const usersToAdd = newUserIds.filter((id) => !currentUserIds.includes(id));
    const usersToRemove = currentUserIds.filter(
      (id) => !newUserIds.includes(id),
    );

    // Get all projects associated with this crew
    const crewProjects = await CrewsProjects.find({ crewId });
    const projectIds = crewProjects.map((cp) => cp.projectId);

    let addedToProjects = 0;
    let removedFromProjects = 0;

    // Remove users from crew and projects
    if (usersToRemove.length > 0) {
      // Use leaveCrew helper to set status to INACTIVE
      const leaveCrewPromises = usersToRemove.map((userId) =>
        this.leaveCrew(new Types.ObjectId(userId), crewId),
      );

      // Remove from all crew projects using leaveProject helper
      const leaveProjectPromises = [];
      if (projectIds.length > 0) {
        for (const userId of usersToRemove) {
          for (const projectId of projectIds) {
            leaveProjectPromises.push(
              ProjectHelper.leaveProject(userId, projectId),
            );
          }
        }
      }

      await Promise.all([...leaveCrewPromises, ...leaveProjectPromises]);
      removedFromProjects = leaveProjectPromises.length;
    }

    // Add new users to crew and projects
    if (usersToAdd.length > 0) {
      // Use joinCrew helper with upsert to add or reactivate members
      const joinCrewPromises = usersToAdd.map((userId) =>
        this.joinCrew(new Types.ObjectId(userId), crewId),
      );

      // Add to all crew projects using joinProject helper
      const joinProjectPromises = [];
      if (projectIds.length > 0) {
        for (const userId of usersToAdd) {
          for (const projectId of projectIds) {
            joinProjectPromises.push(
              ProjectHelper.joinProject(userId, projectId, null),
            );
          }
        }
      }

      await Promise.all([...joinCrewPromises, ...joinProjectPromises]);
      addedToProjects = joinProjectPromises.length;
    }

    return {
      message: "Crew members updated successfully",
      added: usersToAdd.length,
      removed: usersToRemove.length,
      addedToProjects,
      removedFromProjects,
    };
  };

  public static updateCrewProject = async (
    crewId: mongoId,
    projectIds: mongoId[],
    companyId: mongoId,
    currentUserRole: string,
  ) => {
    // Verify the crew exists
    const crew = await Crews.findOne({
      _id: crewId,
      companyId: companyId.toString(),
    });
    if (!crew) {
      throw new Error("Crew not found");
    }

    // Managers and admins can assign any crew to a project (CRE-175).
    if (!isManagerAndAbove(currentUserRole)) {
      throw new Error("You do not have permission to modify this crew");
    }

    // Validate projectIds is an array (can be empty to remove all projects)
    if (!Array.isArray(projectIds)) {
      throw new Error("Project IDs must be an array");
    }

    // Verify all projectIds exist in the company if not empty
    if (projectIds.length > 0) {
      const validProjects = await Project.find({
        _id: { $in: projectIds },
        companyId,
        status: "ACTIVE",
      });

      if (validProjects.length !== projectIds.length) {
        throw new Error("Some project IDs are not valid company projects");
      }
    }

    // Get current crew projects
    const currentProjects = await CrewsProjects.find({ crewId });
    const currentProjectIds = currentProjects.map((p) =>
      p.projectId.toString(),
    );
    const newProjectIds = projectIds.map((id) => id.toString());

    // Find projects to add and remove
    const projectsToAdd = newProjectIds.filter(
      (id) => !currentProjectIds.includes(id),
    );
    const projectsToRemove = currentProjectIds.filter(
      (id) => !newProjectIds.includes(id),
    );

    // Get all crew members (excluding ADMIN and above)
    const crewMembers = await CrewsMembers.find({
      crewId,
      status: "ACTIVE",
    });

    const crewUserIds = crewMembers.map((m) => m.userId);

    // Filter out ADMIN and above users
    const companyMembers = await CompanyMember.find({
      userId: { $in: crewUserIds },
      companyId,
      status: "ACTIVE",
    });

    const nonAdminUserIds = companyMembers
      .filter((m) => !isAdminUser(m.role))
      .map((m) => m.userId);

    let addedMembers = 0;
    let removedMembers = 0;

    // Remove crew from projects
    if (projectsToRemove.length > 0) {
      const deleteCrewProjectsPromise = CrewsProjects.deleteMany({
        crewId,
        projectId: { $in: projectsToRemove },
      });

      // Remove non-admin crew members from these projects using leaveProject helper
      const leaveProjectPromises = [];
      if (nonAdminUserIds.length > 0) {
        for (const userId of nonAdminUserIds) {
          for (const projectId of projectsToRemove) {
            leaveProjectPromises.push(
              ProjectHelper.leaveProject(userId, projectId),
            );
          }
        }
      }

      await Promise.all([deleteCrewProjectsPromise, ...leaveProjectPromises]);
      removedMembers = leaveProjectPromises.length;
    }

    // Add crew to projects
    if (projectsToAdd.length > 0) {
      const newCrewProjects = projectsToAdd.map((pid) => ({
        crewId,
        projectId: pid,
      }));

      const insertCrewProjectsPromise =
        CrewsProjects.insertMany(newCrewProjects);

      // Add non-admin crew members to these projects using joinProject helper
      const joinProjectPromises = [];
      if (nonAdminUserIds.length > 0) {
        for (const userId of nonAdminUserIds) {
          for (const projectId of projectsToAdd) {
            joinProjectPromises.push(
              ProjectHelper.joinProject(userId, projectId, null),
            );
          }
        }
      }

      await Promise.all([insertCrewProjectsPromise, ...joinProjectPromises]);
      addedMembers = joinProjectPromises.length;
    }

    return {
      message: "Crew projects updated successfully",
      projectsAdded: projectsToAdd.length,
      projectsRemoved: projectsToRemove.length,
      membersAdded: addedMembers,
      membersRemoved: removedMembers,
    };
  };

  public static joinCrew = async (userId: mongoId, crewId: mongoId) => {
    return CrewsMembers.findOneAndUpdate(
      {
        crewId,
        userId,
      },
      { $set: { status: "ACTIVE" } },
      { upsert: true, new: true },
    );
  };

  public static leaveCrew = async (userId: mongoId, crewId: mongoId) => {
    return CrewsMembers.findOneAndUpdate(
      {
        crewId,
        userId,
      },
      { $set: { status: "INACTIVE" } },
      { new: true },
    );
  };

  public static getCrewsCount = async (projectId: mongoId) => {
    const response = await CrewsProjects.countDocuments({ projectId });
    return response;
  };
}
