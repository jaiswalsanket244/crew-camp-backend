export * from "./companyCam";
export * from "./proline";

export enum INTEGRATION_PROVIDERS {
  jobnimbus = "jobnimbus",
  proline = "proline",
  roofr = "roofr",
  acculynx = "acculynx",
  // salesforce = "salesforce",
  // hubspot = "hubspot",
  // zapier = "zapier",
}

export enum INTEGRATION_STATUS {
  connected = "connected",
  disconnected = "disconnected",
  error = "error",
}
