/**
 * Proline CRM enums.
 */

// Proline sends the record kind on the webhook payload's `type` field for
// non-project records; project payloads carry `project_id` instead.
export enum PROLINE_RECORD_TYPE {
  project = "project",
  contact = "contact",
}

// Proline's built-in top-level project statuses (the `status` / `project_status`
// field). Companies can rename stages, so this is used for reference/labelling
// only — never to reject a payload.
export enum PROLINE_PROJECT_STATUS {
  lead = "Lead",
  opportunity = "Opportunity",
  active = "Active",
  completed = "Completed",
  closed = "Closed",
  lost = "Lost",
}
