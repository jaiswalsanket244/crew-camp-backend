import { MEMBER_TYPE, USER_ROLE } from "../../utils/enums/enums";
import { ObjectIdType } from "../../utils/interfaces/schemaInterface";
import { ParsedDateRange, QueryClause } from "../types/queries";

// Shared pure OpenSearch clause primitives for the read-path query builders; every builder composes these into a `bool` query with companyScopeClause as the mandatory tenant-isolation chokepoint.

// Thrown when a query is built without a companyId — tenant isolation must FAIL CLOSED: a missing company filter is a hard error, never a silent cross-tenant leak.
export class TenantScopeRequiredError extends Error {
  constructor(
    message = "companyScopeClause requires a companyId (tenant isolation)",
  ) {
    super(message);
    this.name = "TenantScopeRequiredError";
    // Restore the prototype chain (TS extends-Error under an ES5 target) so `instanceof` holds for callers/tests.
    Object.setPrototypeOf(this, TenantScopeRequiredError.prototype);
  }
}

// THE chokepoint — MUST be the first clause in every builder's bool.filter.
export const companyScopeClause = (
  companyId?: ObjectIdType | null,
): QueryClause => {
  if (companyId == null) {
    throw new TenantScopeRequiredError();
  }
  return { term: { companyId: companyId.toString() } };
};

export const termFilter = (field: string, value: unknown): QueryClause => ({
  term: { [field]: value },
});

export const termsFilter = (field: string, values: unknown[]): QueryClause => ({
  terms: { [field]: values },
});

export const rangeFilter = (
  field: string,
  range: ParsedDateRange,
): QueryClause => ({
  range: {
    [field]: {
      ...(range.gte != null ? { gte: range.gte } : {}),
      ...(range.lte != null ? { lte: range.lte } : {}),
    },
  },
});

// Roles with restricted visibility see only projects they belong to (guest is MEMBER_TYPE.GUEST — there is NO USER_ROLE.GUEST). Parity gap: the projects index stores `members` as a flat array of userIds with no per-member type, so this expresses "projects the user is a member of" but not "…specifically as a GUEST". Unrestricted roles get no filter.
const RESTRICTED_ROLES: string[] = [
  MEMBER_TYPE.GUEST,
  USER_ROLE.LIMITED,
  USER_ROLE.CREW,
];

// `role` is typed to the enum union so a mismatch is a COMPILE error rather than a silent fall-through to `match_all` (which would fail OPEN). SECURITY: the role MUST come from a server-trusted source, NEVER a client-supplied value.
export const roleVisibilityClause = (
  role?: USER_ROLE | MEMBER_TYPE,
  userId?: ObjectIdType,
): QueryClause => {
  if (role && userId && RESTRICTED_ROLES.includes(role)) {
    return { terms: { members: [userId.toString()] } };
  }
  return { match_all: {} };
};
