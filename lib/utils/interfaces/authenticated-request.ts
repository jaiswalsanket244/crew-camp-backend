import * as express from "express";
export interface AuthenticatedRequest extends express.Request {
  user: any;
  query: any;
  params: any;
  body: any;
  token?: string;
  files?: any;
  isExternalRequest?: boolean;
}
