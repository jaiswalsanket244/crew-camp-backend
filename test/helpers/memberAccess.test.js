const { expect } = require("chai");
const {
  canEditMemberInfo,
} = require("../../server/utils/helpers/memberAccess");

// Pure permission logic behind PUT /user/updateRole (edit member designation).
// Rule: a requester may edit peers and anyone below them, never a superior.
// Requesters are gated to SUPERADMIN/ADMIN/MANAGER by middleware and self-edits
// are blocked in the handler. Runs against compiled output — no DB / env.
describe("canEditMemberInfo (member designation edit permission)", () => {
  describe("MANAGER", () => {
    // Peers and below.
    ["MANAGER", "STANDARD", "LIMITED", "CREW", "GUEST", "RESTRICTED"].forEach(
      (target) => {
        it(`allows MANAGER to edit ${target}`, () => {
          expect(canEditMemberInfo("MANAGER", target)).to.equal(true);
        });
      },
    );

    // Superiors only.
    ["SUPERADMIN", "ADMIN"].forEach((target) => {
      it(`blocks MANAGER from editing ${target}`, () => {
        expect(canEditMemberInfo("MANAGER", target)).to.equal(false);
      });
    });
  });

  describe("ADMIN", () => {
    // Peers and below.
    ["ADMIN", "MANAGER", "STANDARD", "LIMITED", "CREW"].forEach((target) => {
      it(`allows ADMIN to edit ${target}`, () => {
        expect(canEditMemberInfo("ADMIN", target)).to.equal(true);
      });
    });

    // Only a superadmin is off-limits.
    it("blocks ADMIN from editing SUPERADMIN", () => {
      expect(canEditMemberInfo("ADMIN", "SUPERADMIN")).to.equal(false);
    });
  });

  describe("edge cases", () => {
    it("allows equal-rank peers (handler blocks self separately)", () => {
      expect(canEditMemberInfo("MANAGER", "MANAGER")).to.equal(true);
      expect(canEditMemberInfo("ADMIN", "ADMIN")).to.equal(true);
    });

    it("blocks unknown requester or target roles", () => {
      expect(canEditMemberInfo("BOGUS", "STANDARD")).to.equal(false);
      expect(canEditMemberInfo("MANAGER", "BOGUS")).to.equal(false);
      expect(canEditMemberInfo("", "")).to.equal(false);
    });
  });
});
