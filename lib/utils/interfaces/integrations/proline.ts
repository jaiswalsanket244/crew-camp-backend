/**
 * Proline CRM types.
 *
 * Shapes below mirror the flat webhook payload Proline posts on project
 * create/update. Every field is nullable in practice — Proline sends the full
 * record with `null` for anything unset — so normalization must treat all of
 * them as optional.
 */

// Money/number fields Proline always sends, defaulting to 0.
export interface ProlineFinancials {
  accounts_receivable?: number | null;
  approved_value?: number | null;
  chargebacks?: number | null;
  gross_margin?: number | null;
  gross_profit?: number | null;
  gross_revenue?: number | null;
  merchant_fees?: number | null;
  net_revenue?: number | null;
  quoted_value?: number | null;
  refunds?: number | null;
  project_cost_actual?: number | null;
  project_cost_planned?: number | null;
}

// The seven generic numbered cost buckets Proline exposes per project.
export interface ProlineProjectCosts {
  project_cost_1?: number | null;
  project_cost_2?: number | null;
  project_cost_3?: number | null;
  project_cost_4?: number | null;
  project_cost_5?: number | null;
  project_cost_6?: number | null;
  project_cost_7?: number | null;
}

// The seven generic user-defined text fields Proline exposes per project.
export interface ProlineCustomFields {
  custom_field_1?: string | null;
  custom_field_2?: string | null;
  custom_field_3?: string | null;
  custom_field_4?: string | null;
  custom_field_5?: string | null;
  custom_field_6?: string | null;
  custom_field_7?: string | null;
}

// Primary contact block on a project payload.
export interface ProlinePrimaryContact {
  contact_display?: string | null;
  contact_email?: string | null;
  contact_fname?: string | null;
  contact_id?: string | null;
  contact_lname?: string | null;
  contact_phone?: string | null;
  contact_time_zone?: string | null;
}

// Proline repeats these as other_contact_1_* / other_contact_2_*.
export interface ProlineSecondaryContacts {
  other_contact_1_display?: string | null;
  other_contact_1_email?: string | null;
  other_contact_1_fname?: string | null;
  other_contact_1_id?: string | null;
  other_contact_1_lname?: string | null;
  other_contact_1_phone?: string | null;
  other_contact_2_display?: string | null;
  other_contact_2_email?: string | null;
  other_contact_2_fname?: string | null;
  other_contact_2_id?: string | null;
  other_contact_2_lname?: string | null;
  other_contact_2_phone?: string | null;
}

// Address components. Proline often leaves these null and puts a
// human-entered string in `location` instead.
export interface ProlineAddress {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  location?: string | null;
  area?: string | null;
}

/**
 * Full webhook payload for a Proline project create/update event.
 */
export interface ProlineWebhookPayload
  extends
    ProlineFinancials,
    ProlineProjectCosts,
    ProlineCustomFields,
    ProlinePrimaryContact,
    ProlineSecondaryContacts,
    ProlineAddress {
  // Identity — the only field we hard-require.
  project_id?: string | null;
  project_name?: string | null;
  project_number?: string | null;

  // Assignment
  assigned_to_email?: string | null;
  assigned_to_id?: string | null;
  assigned_to_name?: string | null;
  assigned_to_proline?: string | null;

  // Classification
  category?: string | null;
  project_category?: string | null;
  project_type?: string | null;
  type?: string | null;

  // Pipeline position
  project_status?: string | null;
  status?: string | null;
  stage?: string | null;
  stage_id?: string | null;

  // Collections
  project_services?: string[] | null;
  services?: string[] | null;
  project_tags?: string[] | null;
  tags?: string[] | null;

  notes?: string | null;

  // Proline adds fields over time; keep unknown keys addressable.
  [key: string]: unknown;
}

// ─────────────────────────────────────────────────────────
// Partner API request/response shapes
// Docs: https://docs.proline.app/partner-api
// Every endpoint is POST with a JSON body; the docs do not specify a response
// envelope, so responses are treated as loose objects and probed defensively.
// ─────────────────────────────────────────────────────────

/**
 * POST /v1/files/create_project_file
 *
 * Note: Proline fetches the file itself, server-side — `file_url` must be
 * publicly reachable (or carry auth in its query string). There is no
 * multipart/base64 upload path, and no description or tag field.
 */
export interface ProlineCreateProjectFileRequest {
  project_id: string;
  file_url: string;
  file_name: string;
}

/**
 * POST /v1/activity/create_alert
 * Project-scoped free-text activity. Used to mirror a CrewCam post's note.
 */
export interface ProlineCreateAlertRequest {
  project_id: string;
  contact_id?: string;
  alert_text: string;
  alert_extended?: string;
}

/**
 * POST /v1/import/tags
 *
 * Creates tag *definitions* in the company's vocabulary, keyed by name. This
 * does not attach anything to a project — attaching needs Proline tag IDs via
 * /v1/edit/project.
 */
export interface ProlineImportTagsRequest {
  contact_types?: string[];
  contact_tags?: string[];
  lead_sources?: string[];
  project_types?: string[];
  project_categories?: string[];
  project_tags?: string[];
  project_services?: string[];
  project_areas?: string[];
}

/**
 * POST /v1/edit/project (partial — only the fields we send).
 * `project_tags` takes Proline tag unique IDs, not names.
 */
export interface ProlineEditProjectRequest {
  project_id: string;
  project_name?: string;
  project_notes?: string;
  project_tags?: string[];
  [key: string]: unknown;
}

/**
 * POST /v1/find/project
 */
export interface ProlineFindProjectRequest {
  project_id?: string;
  project_external_id?: string;
  contact_id?: string;
}

/**
 * POST /v1/list/projects — used as a cheap read-only credential probe.
 */
export interface ProlineListProjectsRequest {
  page?: number;
  limit?: number;
  created_after?: string;
  created_before?: string;
}

/**
 * Generic Proline Partner API response.
 *
 * The docs document no response envelope and no error format beyond noting
 * that a breached rate limit returns an error stating "condition is not met",
 * so every field here is optional and read defensively.
 */
export interface ProlineApiResponse {
  status?: string;
  message?: string;
  error?: string;
  statusCode?: number;
  response?: Record<string, unknown>;
  id?: string;
  file_id?: string;
  project_id?: string;
  activity_id?: string;
  [key: string]: unknown;
}

/**
 * Proline's response to a project fetch.
 */
export type ProlineProjectResponse = ProlineWebhookPayload;
