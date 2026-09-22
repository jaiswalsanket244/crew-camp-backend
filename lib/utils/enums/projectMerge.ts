// Which project's value to keep for a field the two projects disagree on.
export enum MERGE_FIELD_CHOICE {
  SOURCE = "SOURCE",
  DESTINATION = "DESTINATION",
}

export const MERGE_FIELD_CHOICES: string[] = [
  MERGE_FIELD_CHOICE.SOURCE,
  MERGE_FIELD_CHOICE.DESTINATION,
];

// Fields the merge review can raise a conflict on. Everything else is either
// unioned (tags, members, crews) or belongs to the destination by definition.
// `location` covers coordinates too — the pair moves as one unit so a project
// can't end up with one project's address and the other's map pin.
export enum MERGE_CONFLICT_FIELD {
  NAME = "name",
  DESCRIPTION = "description",
  LOCATION = "location",
  PROJECT_IMAGE = "projectImage",
  EXTERNAL_MAPPING = "externalMapping",
}

export const MERGE_CONFLICT_FIELDS: MERGE_CONFLICT_FIELD[] = [
  MERGE_CONFLICT_FIELD.NAME,
  MERGE_CONFLICT_FIELD.DESCRIPTION,
  MERGE_CONFLICT_FIELD.LOCATION,
  MERGE_CONFLICT_FIELD.PROJECT_IMAGE,
  MERGE_CONFLICT_FIELD.EXTERNAL_MAPPING,
];
