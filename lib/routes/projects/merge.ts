import { Model, Types } from "mongoose";
import {
  Checklist,
  Comments,
  CrewsProjects,
  DeletedPostFiles,
  Files,
  InvitedUsers,
  Notification,
  PostFiles,
  Posts,
  Project,
  ProjectMember,
  ProjectNotes,
  ProjectReports,
  ProjectTasks,
  SyncJob,
} from "../../db";
import {
  MERGE_CONFLICT_FIELD,
  MERGE_CONFLICT_FIELDS,
  MERGE_FIELD_CHOICE,
} from "../../utils/enums/projectMerge";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import {
  IProjectExternalMapping,
  IProjectMergeAutoFill,
  IProjectMergeConflict,
  IProjectMergePreview,
  IProjectMergeResolutions,
  IProjectMergeResult,
  IProjectMergeSide,
  IProjectMergeTransferCounts,
} from "../../utils/interfaces/project";
import { ProjectPinHelper } from "./pinsHelper";

// The project fields the merge reads. Wider than IProjectMergeSide because the
// guards need company scope and prior-merge state.
export interface IMergeProjectDoc extends IProjectMergeSide {
  companyId?: ObjectIdType;
  mergedInto?: ObjectIdType;
}

// Content collections whose documents simply follow their project via `projectId`.
// Members and crews are handled separately (compound-unique, so they need dedupe);
// everything reachable only through these documents (todolists via checklistId,
// likes via postId, report sections via reportId) moves implicitly.
const CONTENT_COLLECTIONS: {
  key: keyof IProjectMergeTransferCounts;
  model: Model<unknown>;
}[] = [
  { key: "posts", model: Posts as unknown as Model<unknown> },
  { key: "postFiles", model: PostFiles as unknown as Model<unknown> },
  { key: "files", model: Files as unknown as Model<unknown> },
  {
    key: "deletedPostFiles",
    model: DeletedPostFiles as unknown as Model<unknown>,
  },
  { key: "comments", model: Comments as unknown as Model<unknown> },
  { key: "checklists", model: Checklist as unknown as Model<unknown> },
  { key: "tasks", model: ProjectTasks as unknown as Model<unknown> },
  { key: "notes", model: ProjectNotes as unknown as Model<unknown> },
  { key: "reports", model: ProjectReports as unknown as Model<unknown> },
  { key: "invitedUsers", model: InvitedUsers as unknown as Model<unknown> },
  { key: "notifications", model: Notification as unknown as Model<unknown> },
  { key: "syncJobs", model: SyncJob as unknown as Model<unknown> },
];

const emptyTransferCounts = (): IProjectMergeTransferCounts => ({
  posts: 0,
  postFiles: 0,
  files: 0,
  deletedPostFiles: 0,
  comments: 0,
  checklists: 0,
  tasks: 0,
  notes: 0,
  reports: 0,
  invitedUsers: 0,
  notifications: 0,
  syncJobs: 0,
  members: 0,
  crews: 0,
});

const isBlank = (value?: string): boolean =>
  value === undefined || value === null || `${value}`.trim() === "";

const hasMapping = (mapping?: IProjectExternalMapping): boolean =>
  !!mapping?.system && !!mapping?.externalId;

const sameMapping = (
  a?: IProjectExternalMapping,
  b?: IProjectExternalMapping,
): boolean => a?.system === b?.system && a?.externalId === b?.externalId;

const toSide = (project: IMergeProjectDoc): IProjectMergeSide => ({
  _id: project._id,
  name: project.name,
  description: project.description,
  location: project.location,
  coordinates: project.coordinates,
  projectImage: project.projectImage,
  tags: project.tags,
  externalMapping: project.externalMapping,
  createdAt: project.createdAt,
  archivedAt: project.archivedAt,
});

export class ProjectMergeHelper {
  public static getProjectForMerge = async (
    projectId: ObjectIdType,
  ): Promise<IMergeProjectDoc | null> => {
    return Project.findById(projectId, {
      name: 1,
      description: 1,
      location: 1,
      coordinates: 1,
      projectImage: 1,
      tags: 1,
      externalMapping: 1,
      companyId: 1,
      archivedAt: 1,
      mergedInto: 1,
      createdAt: 1,
    }).lean<IMergeProjectDoc>();
  };

  // Compares the two projects field by field. A field is a *conflict* only when both
  // sides hold a differing non-empty value; when the destination is empty the source's
  // value is carried over automatically (nothing to decide, nothing discarded).
  // `location` is evaluated together with `coordinates` so the address and the map pin
  // can never come from different projects.
  public static getFieldDiff = (
    source: IMergeProjectDoc,
    destination: IMergeProjectDoc,
  ): {
    conflicts: IProjectMergeConflict[];
    autoFilled: IProjectMergeAutoFill[];
  } => {
    const conflicts: IProjectMergeConflict[] = [];
    const autoFilled: IProjectMergeAutoFill[] = [];

    for (const field of MERGE_CONFLICT_FIELDS) {
      if (field === MERGE_CONFLICT_FIELD.EXTERNAL_MAPPING) {
        if (!hasMapping(source.externalMapping)) continue;
        if (!hasMapping(destination.externalMapping)) {
          autoFilled.push({ field, value: source.externalMapping });
        } else if (
          !sameMapping(source.externalMapping, destination.externalMapping)
        ) {
          conflicts.push({
            field,
            sourceValue: source.externalMapping,
            destinationValue: destination.externalMapping,
          });
        }
        continue;
      }

      if (field === MERGE_CONFLICT_FIELD.LOCATION) {
        if (isBlank(source.location)) continue;
        if (isBlank(destination.location)) {
          autoFilled.push({
            field,
            value: {
              location: source.location,
              coordinates: source.coordinates,
            },
          });
        } else if (source.location.trim() !== destination.location.trim()) {
          conflicts.push({
            field,
            sourceValue: {
              location: source.location,
              coordinates: source.coordinates,
            },
            destinationValue: {
              location: destination.location,
              coordinates: destination.coordinates,
            },
          });
        } else if (!destination.coordinates?.latitude && source.coordinates) {
          // Same address, but only the source has a resolved pin — keep it.
          autoFilled.push({
            field,
            value: { coordinates: source.coordinates },
          });
        }
        continue;
      }

      const sourceValue = source[field] as string;
      const destinationValue = destination[field] as string;
      if (isBlank(sourceValue)) continue;
      if (isBlank(destinationValue)) {
        autoFilled.push({ field, value: sourceValue });
      } else if (sourceValue.trim() !== destinationValue.trim()) {
        conflicts.push({ field, sourceValue, destinationValue });
      }
    }

    return { conflicts, autoFilled };
  };

  private static tagsUnion = (
    source: IMergeProjectDoc,
    destination: IMergeProjectDoc,
  ): string[] => {
    const union = new Set<string>();
    for (const tag of destination.tags ?? []) union.add(tag.toString());
    for (const tag of source.tags ?? []) union.add(tag.toString());
    return Array.from(union);
  };

  // Member/crew rows the source holds that the destination does not already have.
  // Returns both sides so the preview can report how many rows are duplicates.
  private static splitMemberships = async (
    sourceProjectId: ObjectIdType,
    destinationProjectId: ObjectIdType,
  ): Promise<{
    memberIdsToMove: ObjectIdType[];
    crewIdsToMove: ObjectIdType[];
    duplicateMembers: number;
    duplicateCrews: number;
  }> => {
    const [sourceMembers, destinationMembers, sourceCrews, destinationCrews] =
      await Promise.all([
        ProjectMember.find({ projectId: sourceProjectId }, { userId: 1 }).lean<
          { _id: ObjectIdType; userId: ObjectIdType }[]
        >(),
        ProjectMember.find(
          { projectId: destinationProjectId },
          { userId: 1 },
        ).lean<{ userId: ObjectIdType }[]>(),
        CrewsProjects.find({ projectId: sourceProjectId }, { crewId: 1 }).lean<
          { _id: ObjectIdType; crewId: ObjectIdType }[]
        >(),
        CrewsProjects.find(
          { projectId: destinationProjectId },
          { crewId: 1 },
        ).lean<{ crewId: ObjectIdType }[]>(),
      ]);

    const existingUserIds = new Set(
      destinationMembers.map((member) => member.userId?.toString()),
    );
    const existingCrewIds = new Set(
      destinationCrews.map((crew) => crew.crewId?.toString()),
    );

    const memberIdsToMove = sourceMembers
      .filter((member) => !existingUserIds.has(member.userId?.toString()))
      .map((member) => member._id);
    const crewIdsToMove = sourceCrews
      .filter((crew) => !existingCrewIds.has(crew.crewId?.toString()))
      .map((crew) => crew._id);

    return {
      memberIdsToMove,
      crewIdsToMove,
      duplicateMembers: sourceMembers.length - memberIdsToMove.length,
      duplicateCrews: sourceCrews.length - crewIdsToMove.length,
    };
  };

  public static buildPreview = async (
    source: IMergeProjectDoc,
    destination: IMergeProjectDoc,
  ): Promise<IProjectMergePreview> => {
    const { conflicts, autoFilled } = this.getFieldDiff(source, destination);

    const [counts, memberships] = await Promise.all([
      Promise.all(
        CONTENT_COLLECTIONS.map(({ key, model }) =>
          model
            .countDocuments({ projectId: source._id })
            .then((count) => ({ key, count })),
        ),
      ),
      this.splitMemberships(source._id, destination._id),
    ]);

    const transfers = emptyTransferCounts();
    for (const { key, count } of counts) transfers[key] = count;
    transfers.members = memberships.memberIdsToMove.length;
    transfers.crews = memberships.crewIdsToMove.length;

    return {
      keeping: toSide(destination),
      archiving: toSide(source),
      conflicts,
      autoFilled,
      tags: { union: this.tagsUnion(source, destination) },
      transfers,
      duplicates: {
        members: memberships.duplicateMembers,
        crews: memberships.duplicateCrews,
      },
    };
  };

  // Fields that must still be decided by the caller: every detected conflict without
  // a resolution. The merge refuses to run while this is non-empty, so a conflicting
  // value is never dropped implicitly.
  public static getUnresolvedConflicts = (
    conflicts: IProjectMergeConflict[],
    resolutions: IProjectMergeResolutions,
  ): MERGE_CONFLICT_FIELD[] =>
    conflicts
      .filter((conflict) => !resolutions?.[conflict.field])
      .map((conflict) => conflict.field);

  // Moves every supported piece of content onto the destination, applies the resolved
  // field values, and only then archives the source and stamps it as merged — so a
  // failure part way through leaves the source live and retryable rather than archived
  // with content still attached. Re-running a partially completed merge is safe: each
  // step is an idempotent `projectId` re-point.
  public static execute = async ({
    source,
    destination,
    resolutions,
    userId,
  }: {
    source: IMergeProjectDoc;
    destination: IMergeProjectDoc;
    resolutions: IProjectMergeResolutions;
    userId: ObjectIdType;
  }): Promise<IProjectMergeResult> => {
    const { conflicts, autoFilled } = this.getFieldDiff(source, destination);
    const transfers = emptyTransferCounts();

    for (const { key, model } of CONTENT_COLLECTIONS) {
      const result = await model.updateMany(
        { projectId: source._id },
        { $set: { projectId: destination._id } },
      );
      transfers[key] = result.modifiedCount ?? 0;
    }

    const memberships = await this.splitMemberships(
      source._id,
      destination._id,
    );

    if (memberships.memberIdsToMove.length) {
      await ProjectMember.updateMany(
        { _id: { $in: memberships.memberIdsToMove } },
        { $set: { projectId: destination._id } },
      );
      transfers.members = memberships.memberIdsToMove.length;
    }
    if (memberships.crewIdsToMove.length) {
      await CrewsProjects.updateMany(
        { _id: { $in: memberships.crewIdsToMove } },
        { $set: { projectId: destination._id } },
      );
      transfers.crews = memberships.crewIdsToMove.length;
    }

    // Duplicate rows would otherwise point at a project that no longer holds anything.
    // Pins are dropped rather than moved onto the destination: the survivor normally keeps its
    // OWN name, so a transferred pin would leave a rail entry silently relabelled to a project
    // the user never pinned. Users lose the shortcut either way — as they already do today —
    // but the row no longer lingers invisibly against their MAX_PINS_PER_USER cap.
    await Promise.all([
      ProjectMember.deleteMany({ projectId: source._id }),
      CrewsProjects.deleteMany({ projectId: source._id }),
      ProjectPinHelper.deleteByProject(source._id),
    ]);

    const { update, appliedFields, mappingToMove } =
      this.buildDestinationUpdate({
        source,
        destination,
        conflicts,
        autoFilled,
        resolutions,
      });

    if (Object.keys(update).length) {
      await Project.updateOne({ _id: destination._id }, { $set: update });
    }

    // The partial unique index on companyId + externalMapping.system + externalId
    // permits one holder per CRM job, so the source has to release the mapping
    // before the destination can take it. Handed over as its own step and rolled
    // back on failure — a dropped unset + failed set would lose the CRM link.
    if (mappingToMove) {
      await Project.updateOne(
        { _id: source._id },
        { $unset: { externalMapping: "" } },
      );
      try {
        await Project.updateOne(
          { _id: destination._id },
          { $set: { externalMapping: mappingToMove } },
        );
      } catch (error) {
        await Project.updateOne(
          { _id: source._id },
          { $set: { externalMapping: mappingToMove } },
        );
        throw error;
      }
    }

    const mergedAt = new Date();
    await Project.updateOne(
      { _id: source._id },
      {
        $set: {
          archivedAt: mergedAt,
          mergedInto: destination._id,
          mergedAt,
          mergedBy: userId,
        },
      },
    );

    return {
      sourceProjectId: source._id,
      destinationProjectId: destination._id,
      transfers,
      duplicates: {
        members: memberships.duplicateMembers,
        crews: memberships.duplicateCrews,
      },
      appliedFields,
      mergedAt,
    };
  };

  // Turns the auto-filled fields plus the caller's conflict choices into one $set for
  // the destination. Tags are always unioned. A DESTINATION choice leaves the source's
  // value untouched on the archived project, so nothing is destroyed either way.
  private static buildDestinationUpdate = ({
    source,
    destination,
    conflicts,
    autoFilled,
    resolutions,
  }: {
    source: IMergeProjectDoc;
    destination: IMergeProjectDoc;
    conflicts: IProjectMergeConflict[];
    autoFilled: IProjectMergeAutoFill[];
    resolutions: IProjectMergeResolutions;
  }): {
    update: Record<string, unknown>;
    appliedFields: string[];
    // Kept out of `update` because the CRM mapping needs its own release-then-take
    // sequence against the partial unique index (see execute).
    mappingToMove?: IProjectExternalMapping;
  } => {
    const update: Record<string, unknown> = {};
    const appliedFields: string[] = [];
    let mappingToMove: IProjectExternalMapping;

    const takeFromSource = (field: MERGE_CONFLICT_FIELD): void => {
      switch (field) {
        case MERGE_CONFLICT_FIELD.LOCATION:
          if (!isBlank(source.location)) update.location = source.location;
          if (source.coordinates) update.coordinates = source.coordinates;
          break;
        case MERGE_CONFLICT_FIELD.EXTERNAL_MAPPING:
          mappingToMove = source.externalMapping;
          break;
        default:
          update[field] = source[field];
      }
      appliedFields.push(field);
    };

    for (const { field } of autoFilled) takeFromSource(field);

    for (const { field } of conflicts) {
      if (resolutions?.[field] === MERGE_FIELD_CHOICE.SOURCE) {
        takeFromSource(field);
      }
    }

    const tagsUnion = this.tagsUnion(source, destination);
    const destinationTags = (destination.tags ?? []).map((tag) =>
      tag.toString(),
    );
    if (tagsUnion.length !== destinationTags.length) {
      update.tags = tagsUnion.map((tag) => new Types.ObjectId(tag));
      appliedFields.push("tags");
    }

    return { update, appliedFields, mappingToMove };
  };
}
