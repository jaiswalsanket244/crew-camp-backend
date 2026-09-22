const { expect } = require("chai");
const mongoose = require("mongoose");

describe("Project merge conflict detection", function () {
  let ProjectMergeHelper;
  let MERGE_CONFLICT_FIELD;
  let MERGE_FIELD_CHOICE;

  const project = (fields) => ({
    _id: new mongoose.Types.ObjectId(),
    ...fields,
  });

  const fieldsOf = (entries) => entries.map((entry) => entry.field);

  before(function () {
    ProjectMergeHelper =
      require("../../server/routes/projects/merge").ProjectMergeHelper;
    const enums = require("../../server/utils/enums/projectMerge");
    MERGE_CONFLICT_FIELD = enums.MERGE_CONFLICT_FIELD;
    MERGE_FIELD_CHOICE = enums.MERGE_FIELD_CHOICE;
  });

  it("raises a conflict only when both projects hold differing non-empty values", function () {
    const { conflicts, autoFilled } = ProjectMergeHelper.getFieldDiff(
      project({ name: "Elm St Reroof", description: "second entry" }),
      project({ name: "Elm Street Reroof" }),
    );

    expect(fieldsOf(conflicts)).to.deep.equal([MERGE_CONFLICT_FIELD.NAME]);
    // The destination has no description, so the source's carries over silently.
    expect(fieldsOf(autoFilled)).to.deep.equal([
      MERGE_CONFLICT_FIELD.DESCRIPTION,
    ]);
  });

  it("treats whitespace-only and identical values as no conflict", function () {
    const { conflicts, autoFilled } = ProjectMergeHelper.getFieldDiff(
      project({ name: " Elm St ", description: "   " }),
      project({ name: "Elm St" }),
    );

    expect(conflicts).to.have.length(0);
    expect(autoFilled).to.have.length(0);
  });

  it("keeps location and coordinates together as one choice", function () {
    const { conflicts } = ProjectMergeHelper.getFieldDiff(
      project({
        location: "12 Elm St",
        coordinates: { latitude: 1, longitude: 2 },
      }),
      project({
        location: "14 Elm St",
        coordinates: { latitude: 3, longitude: 4 },
      }),
    );

    expect(conflicts).to.have.length(1);
    expect(conflicts[0].field).to.equal(MERGE_CONFLICT_FIELD.LOCATION);
    expect(conflicts[0].sourceValue).to.deep.equal({
      location: "12 Elm St",
      coordinates: { latitude: 1, longitude: 2 },
    });
    expect(conflicts[0].destinationValue).to.deep.equal({
      location: "14 Elm St",
      coordinates: { latitude: 3, longitude: 4 },
    });
  });

  it("carries over the source's map pin when the address matches but the destination has none", function () {
    const { conflicts, autoFilled } = ProjectMergeHelper.getFieldDiff(
      project({
        location: "12 Elm St",
        coordinates: { latitude: 1, longitude: 2 },
      }),
      project({ location: "12 Elm St" }),
    );

    expect(conflicts).to.have.length(0);
    expect(autoFilled).to.deep.equal([
      {
        field: MERGE_CONFLICT_FIELD.LOCATION,
        value: { coordinates: { latitude: 1, longitude: 2 } },
      },
    ]);
  });

  it("conflicts on CRM mappings pointing at different jobs but not on matching ones", function () {
    const mapping = { system: "JOBNIMBUS", externalId: "job-1" };

    const differing = ProjectMergeHelper.getFieldDiff(
      project({ externalMapping: mapping }),
      project({
        externalMapping: { system: "JOBNIMBUS", externalId: "job-2" },
      }),
    );
    expect(fieldsOf(differing.conflicts)).to.deep.equal([
      MERGE_CONFLICT_FIELD.EXTERNAL_MAPPING,
    ]);

    const matching = ProjectMergeHelper.getFieldDiff(
      project({ externalMapping: mapping }),
      project({ externalMapping: mapping }),
    );
    expect(matching.conflicts).to.have.length(0);
    expect(matching.autoFilled).to.have.length(0);

    const unmappedDestination = ProjectMergeHelper.getFieldDiff(
      project({ externalMapping: mapping }),
      project({}),
    );
    expect(fieldsOf(unmappedDestination.autoFilled)).to.deep.equal([
      MERGE_CONFLICT_FIELD.EXTERNAL_MAPPING,
    ]);
    expect(unmappedDestination.conflicts).to.have.length(0);
  });

  it("reports every conflict left without an explicit choice", function () {
    const conflicts = [
      { field: MERGE_CONFLICT_FIELD.NAME },
      { field: MERGE_CONFLICT_FIELD.LOCATION },
      { field: MERGE_CONFLICT_FIELD.PROJECT_IMAGE },
    ];

    const unresolved = ProjectMergeHelper.getUnresolvedConflicts(conflicts, {
      [MERGE_CONFLICT_FIELD.NAME]: MERGE_FIELD_CHOICE.SOURCE,
      [MERGE_CONFLICT_FIELD.LOCATION]: MERGE_FIELD_CHOICE.DESTINATION,
    });

    expect(unresolved).to.deep.equal([MERGE_CONFLICT_FIELD.PROJECT_IMAGE]);
    expect(
      ProjectMergeHelper.getUnresolvedConflicts(conflicts, {}),
    ).to.have.length(3);
  });
});
