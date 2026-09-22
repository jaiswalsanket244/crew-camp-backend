import { MEMBER_TYPE, USER_ROLE } from "../enums/enums";

export const isAdminUser = (role = "") => {
  return role === USER_ROLE.ADMIN;
};

export const isManagerAndAbove = (role = "") => {
  const allowedRoles: string[] = [USER_ROLE.ADMIN, USER_ROLE.MANAGER];
  return allowedRoles.includes(role);
};

export const isStandardAndAbove = (role = "") => {
  const allowedRoles: string[] = [
    USER_ROLE.ADMIN,
    USER_ROLE.MANAGER,
    USER_ROLE.STANDARD,
  ];

  return allowedRoles.includes(role);
};

export const allowChangeUserAccess = (
  currentUser: string,
  teamMember: string,
) => {
  const role = {
    [USER_ROLE.ADMIN]: 1,
    [USER_ROLE.MANAGER]: 2,
    [USER_ROLE.STANDARD]: 3,
    [USER_ROLE.LIMITED]: 4,
    [USER_ROLE.CREW]: 4,
  };
  return role[currentUser] < role[teamMember];
};

// Rank ordering used for deactivate / re-enable. Lower number means more
// authority; an actor may only change the state of a strictly lower-ranked
// member, so admins can act on managers and below while managers are limited to
// non-managers. Unknown roles on either side are always denied.
const MEMBER_STATE_RANK: Record<string, number> = {
  [USER_ROLE.SUPERADMIN]: 0,
  [USER_ROLE.ADMIN]: 1,
  [USER_ROLE.MANAGER]: 2,
  [USER_ROLE.STANDARD]: 3,
  [USER_ROLE.LIMITED]: 4,
  [USER_ROLE.CREW]: 4,
  [MEMBER_TYPE.GUEST]: 5,
};

export const allowChangeMemberState = (actorRole = "", targetRole = "") => {
  const actorRank = MEMBER_STATE_RANK[actorRole];
  const targetRank = MEMBER_STATE_RANK[targetRole];

  if (actorRank === undefined || targetRank === undefined) return false;

  return actorRank < targetRank;
};
