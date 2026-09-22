import { Types } from "mongoose";
import { Project, ProjectMember, ProjectPin } from "../../db";
import { CURRENT_STATUS, MEMBER_TYPE } from "../../utils/enums/enums";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { MAX_PINS_PER_USER } from "../../utils/constants/constants";

export interface ProjectPinRow {
  projectId: ObjectIdType;
  pinnedAt: Date;
}

// What the sidebar rail actually renders — nothing else.
export interface PinnedProjectSummary {
  _id: ObjectIdType;
  name: string;
  pinnedAt: Date;
}

// Stable reorder for UNPAGINATED result sets: rows whose _id is pinned move to the front in pin
// order (most recently pinned first); everything else keeps the order the query produced. Paged
// endpoints must not use this — they splice pinned rows in at the handler (see getAllDataV2),
// because reordering only the current page would leave pins stranded on later pages.
export const orderPinnedFirst = <T extends { _id?: unknown }>(
  rows: T[],
  pinnedIds: ObjectIdType[],
): T[] => {
  if (!pinnedIds.length || !rows.length) {
    return rows;
  }
  const rank = new Map<string, number>();
  pinnedIds.forEach((id, i) => rank.set(id.toString(), i));
  const pinned: T[] = [];
  const rest: T[] = [];
  rows.forEach((row) => {
    if (rank.has(String(row._id))) {
      pinned.push(row);
    } else {
      rest.push(row);
    }
  });
  pinned.sort((a, b) => rank.get(String(a._id)) - rank.get(String(b._id)));
  return [...pinned, ...rest];
};

export class ProjectPinHelper {
  // The caller's pinned project ids, most-recently-pinned first. Capped at MAX_PINS_PER_USER so
  // a corrupt/legacy over-cap state can never widen the list read path. companyId is optional —
  // callers that already scope by project membership (findAll, /all) can omit it.
  public static listPinned = async (
    userId: Types.ObjectId,
    companyId?: ObjectIdType,
  ): Promise<ProjectPinRow[]> => {
    if (!userId) {
      return [];
    }
    const query: Record<string, unknown> = { userId };
    if (companyId) {
      query.companyId = companyId;
    }
    const rows = await ProjectPin.find(query, {
      projectId: 1,
      pinnedAt: 1,
      _id: 0,
    })
      .sort({ pinnedAt: -1 })
      .limit(MAX_PINS_PER_USER)
      .lean();
    return rows as unknown as ProjectPinRow[];
  };

  public static listPinnedProjectIds = async (
    userId: Types.ObjectId,
    companyId?: ObjectIdType,
  ): Promise<ObjectIdType[]> => {
    const rows = await ProjectPinHelper.listPinned(userId, companyId);
    return rows.map((r) => r.projectId);
  };

  // Sidebar-rail read: the caller's pins resolved to { _id, name, pinnedAt }, in pin order.
  // Two index-served reads (the covered pin lookup + one _id-keyed projects fetch) instead of
  // routing the rail through /projects/list, whose Mongo path fans five sub-counts out per row.
  // Pins whose project is archived, non-ACTIVE, or no longer in this company are dropped — the
  // same set the rail saw when it filtered a `showArchived=false` list response.
  public static listPinnedSummaries = async (
    userId: Types.ObjectId,
    companyId: ObjectIdType,
    restrictToMemberships = false,
  ): Promise<PinnedProjectSummary[]> => {
    const rows = await ProjectPinHelper.listPinned(userId, companyId);
    if (!rows.length) {
      return [];
    }

    let pinnedIds = rows.map((r) => r.projectId);

    // LIMITED/CREW roles only see projects they belong to, so a pin must never resurface a
    // project the caller has since lost access to — intersect rather than trust the pin row.
    // Scoped to the pinned ids (bounded by MAX_PINS_PER_USER) so it rides the
    // (projectId, userId) index instead of scanning the caller's whole membership list.
    if (restrictToMemberships) {
      const memberships = await ProjectMember.find(
        {
          userId,
          projectId: { $in: pinnedIds },
          status: CURRENT_STATUS.ACTIVE,
          type: { $ne: MEMBER_TYPE.GUEST },
        },
        { projectId: 1, _id: 0 },
      ).lean();
      const allowed = new Set(
        (memberships as unknown as Array<{ projectId: ObjectIdType }>).map(
          (m) => m.projectId.toString(),
        ),
      );
      pinnedIds = pinnedIds.filter((id) => allowed.has(id.toString()));
      if (!pinnedIds.length) {
        return [];
      }
    }

    const projects = await Project.find(
      {
        _id: { $in: pinnedIds },
        companyId,
        status: CURRENT_STATUS.ACTIVE,
        archivedAt: { $exists: false },
      },
      { _id: 1, name: 1 },
    ).lean();

    const nameById = new Map<string, string>();
    (projects as unknown as Array<{ _id: ObjectIdType; name: string }>).forEach(
      (p) => nameById.set(p._id.toString(), p.name),
    );

    // `rows` carries pin order (most recently pinned first); a pin whose project failed the
    // filters above simply has no name entry and drops out here.
    return rows.reduce<PinnedProjectSummary[]>((acc, row) => {
      const name = nameById.get(row.projectId.toString());
      if (name !== undefined) {
        acc.push({ _id: row.projectId, name, pinnedAt: row.pinnedAt });
      }
      return acc;
    }, []);
  };

  public static countForUser = async (
    userId: Types.ObjectId,
    companyId: ObjectIdType,
  ): Promise<number> => {
    return ProjectPin.countDocuments({ userId, companyId });
  };

  // Idempotent: re-pinning an already-pinned project just bumps pinnedAt to the top.
  public static pin = async (
    userId: Types.ObjectId,
    companyId: ObjectIdType,
    projectId: ObjectIdType,
  ) => {
    return ProjectPin.findOneAndUpdate(
      { userId, projectId },
      { $set: { pinnedAt: new Date(), companyId } },
      { upsert: true, new: true },
    );
  };

  public static unpin = async (
    userId: Types.ObjectId,
    projectId: ObjectIdType,
  ) => {
    return ProjectPin.deleteOne({ userId, projectId });
  };

  // Cascade cleanup — pins to a project that is gone (merged away, hard-deleted) are invisible
  // to every read path, so without this they would count against the cap forever. Called by the
  // merge (see merge.ts execute) for the source project.
  public static deleteByProject = async (projectId: ObjectIdType) => {
    return ProjectPin.deleteMany({ projectId });
  };

  // Active, non-GUEST members of a project. Guests are external (homeowners/clients), so a
  // team-wide pin deliberately skips them.
  public static listPinnableMemberIds = async (
    projectId: ObjectIdType,
  ): Promise<ObjectIdType[]> => {
    const rows = await ProjectMember.find(
      {
        projectId,
        status: CURRENT_STATUS.ACTIVE,
        type: { $ne: MEMBER_TYPE.GUEST },
      },
      { userId: 1, _id: 0 },
    ).lean();
    // De-dupe: projectmembers has a non-unique (projectId, userId) index, so duplicate rows for
    // the same user are possible and would otherwise inflate the reported pin count.
    const seen = new Set<string>();
    const userIds: ObjectIdType[] = [];
    (rows as unknown as Array<{ userId: ObjectIdType }>).forEach((r) => {
      const key = r.userId.toString();
      if (!seen.has(key)) {
        seen.add(key);
        userIds.push(r.userId);
      }
    });
    return userIds;
  };

  // Fans one pin out to a set of users in a single bulkWrite. Users already at
  // MAX_PINS_PER_USER are skipped and reported rather than pushed over the cap — going over
  // would silently drop their oldest pin out of the list read path, which clamps to the cap.
  // Users who already have this project pinned keep their original pinnedAt (no reshuffle) and
  // are exempt from the cap check.
  public static pinForUsers = async (
    userIds: ObjectIdType[],
    companyId: ObjectIdType,
    projectId: ObjectIdType,
  ): Promise<{
    pinnedFor: number;
    alreadyPinned: number;
    skippedAtCap: number;
  }> => {
    if (!userIds.length) {
      return { pinnedFor: 0, alreadyPinned: 0, skippedAtCap: 0 };
    }

    const [existingForProject, counts] = await Promise.all([
      ProjectPin.find(
        { projectId, userId: { $in: userIds } },
        { userId: 1, _id: 0 },
      ).lean(),
      // One grouped count instead of a countDocuments per member.
      ProjectPin.aggregate([
        { $match: { companyId, userId: { $in: userIds } } },
        { $group: { _id: "$userId", n: { $sum: 1 } } },
      ]),
    ]);

    const alreadyPinnedIds = new Set(
      (existingForProject as unknown as Array<{ userId: ObjectIdType }>).map(
        (r) => r.userId.toString(),
      ),
    );
    const countByUser = new Map<string, number>();
    (counts as Array<{ _id: ObjectIdType; n: number }>).forEach((c) => {
      countByUser.set(c._id.toString(), c.n);
    });

    const pinnedAt = new Date();
    const ops = [];
    let skippedAtCap = 0;
    userIds.forEach((userId) => {
      const key = userId.toString();
      if (alreadyPinnedIds.has(key)) {
        return;
      }
      if ((countByUser.get(key) ?? 0) >= MAX_PINS_PER_USER) {
        skippedAtCap += 1;
        return;
      }
      ops.push({
        updateOne: {
          filter: { userId, projectId },
          update: { $set: { userId, projectId, companyId, pinnedAt } },
          upsert: true,
        },
      });
    });

    if (ops.length) {
      // ordered:false so one duplicate-key race does not abort the rest of the fan-out.
      await ProjectPin.bulkWrite(ops, { ordered: false });
    }

    return {
      pinnedFor: ops.length,
      alreadyPinned: alreadyPinnedIds.size,
      skippedAtCap,
    };
  };

  // Removes a project's pin for every user, not just the caller. Returns the number cleared so
  // the route can report it.
  public static unpinForAll = async (
    projectId: ObjectIdType,
  ): Promise<number> => {
    const result = await ProjectPin.deleteMany({ projectId });
    return result.deletedCount ?? 0;
  };

  public static isPinned = async (
    userId: Types.ObjectId,
    projectId: ObjectIdType,
  ): Promise<Date | null> => {
    if (!userId || !projectId) {
      return null;
    }
    const row = await ProjectPin.findOne(
      { userId, projectId },
      { pinnedAt: 1, _id: 0 },
    ).lean();
    return (row as unknown as { pinnedAt?: Date })?.pinnedAt ?? null;
  };

  // Tenant guard for the pin route: confirms the project exists, is ACTIVE, and belongs to the
  // caller's company. The pre-existing pin handler used an unscoped findByIdAndUpdate, which let
  // any authenticated user pin any project in any company by id.
  public static assertProjectInCompany = async (
    projectId: ObjectIdType,
    companyId: ObjectIdType,
  ): Promise<boolean> => {
    const project = await Project.findOne(
      { _id: projectId, companyId, status: CURRENT_STATUS.ACTIVE },
      { _id: 1 },
    ).lean();
    return Boolean(project);
  };
}
