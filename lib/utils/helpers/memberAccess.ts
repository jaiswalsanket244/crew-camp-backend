// Company role ranking — lower number = higher privilege. A requester may edit
// a member's info when their rank is equal to or higher (smaller or equal) than
// the target's, i.e. peers and below — never a superior. Requesters are already
// gated to SUPERADMIN/ADMIN/MANAGER by adminOrManagerMiddleware, and self-edits
// are blocked separately in the handler. Mirrors the web app's
// allowEditMemberInfo hierarchy.
export const MEMBER_ROLE_RANK: Record<string, number> = {
  SUPERADMIN: 0,
  ADMIN: 1,
  MANAGER: 2,
  STANDARD: 3,
  LIMITED: 4,
  CREW: 4,
  GUEST: 4,
  RESTRICTED: 5,
};

export const canEditMemberInfo = (
  requesterRole = "",
  targetRole = "",
): boolean => {
  const requesterRank = MEMBER_ROLE_RANK[requesterRole];
  const targetRank = MEMBER_ROLE_RANK[targetRole];
  if (requesterRank === undefined || targetRank === undefined) return false;
  return requesterRank <= targetRank;
};
