export enum CHECKLIST_STATUS {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  DELETED = "DELETED",
}

export enum CHECKLIST_TYPE {
  CHECKLIST = "checklist",
  TEMPLATE = "template",
}

export enum FIELD_TYPE {
  CHECKBOX = "checkbox",
  TEXT = "text",
  PHOTO = "photo", // reserved for future field-level photos; not accepted in v1 payloads
  YES_NO = "yes_no",
  RATING = "rating",
  SELECT = "select",
  MULTI_SELECT = "multi_select",
  NUMBER = "number",
  DATE = "date",
}
