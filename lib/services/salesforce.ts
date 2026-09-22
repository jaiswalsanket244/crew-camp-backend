import axios from "axios";
import * as fs from "fs";
import path = require("path");
import * as jwt from "jsonwebtoken";
import {
  ICreateLead,
  ISalesforceCompositeRecord,
  ISalesforceCompositeResult,
  ISalesforceLeadRecord,
  ISalesforceQueryResponse,
  ISalesforceRequestError,
} from "../utils/interfaces/saleForcesServices";
import { config } from "../utils/configuration/config";
import { EmailService } from "./email";
import {
  SALESFORCE_API_VERSION,
  SALESFORCE_COMPOSITE_BATCH_SIZE,
  SALESFORCE_TOKEN_TTL_MS,
} from "../utils/enums/salesforce";
import { ObjectIdType } from "../utils/interfaces/schemaInterface";
import { User } from "../db";

export class SalesForceService {
  public static readonly SALESFORCE_CLIENT_ID: string =
    config.SALESFORCE_CLIENT_ID;
  public static readonly SALESFORCE_USERNAME: string =
    config.SALESFORCE_USERNAME;
  public static readonly SALESFORCE_LOGIN_URL: string =
    config.SALESFORCE_LOGIN_URL;
  public static readonly SALESFORCE_INSTANCE_URL: string =
    config.SALESFORCE_INSTANCE_URL;

  private static cachedToken: string | null = null;
  private static cachedTokenExpiresAt = 0;

  private static get dataUrl(): string {
    return `${this.SALESFORCE_INSTANCE_URL}/services/data/${SALESFORCE_API_VERSION}`;
  }

  private static async sendLeadErrorNotification(
    operation: string,
    leadEmail: string,
    error: any,
    leadData?: ICreateLead,
  ) {
    try {
      const emailService = new EmailService();
      const errorDetails = {
        message: error.message || "Unknown error",
        response: error.response?.data || null,
        status: error.response?.status || null,
        statusText: error.response?.statusText || null,
        timestamp: new Date().toISOString(),
      };

      const emailBody = `
Salesforce Lead ${operation} Failed

Lead Email: ${leadEmail}

Lead Details:
${leadData ? JSON.stringify(leadData, null, 2) : "N/A"}

Error Details:
${JSON.stringify(errorDetails, null, 2)}

Environment: ${config.NODE_ENV}
Instance URL: ${this.SALESFORCE_INSTANCE_URL}

Please investigate this issue immediately.
      `;

      await emailService.sendEmail({
        subject: `[ALERT] Salesforce Lead ${operation} Failed - ${leadEmail}`,
        email: config.SENDGRID_TEST_EMAIL,
        data: emailBody,
      });
    } catch {
      /* empty */
    }
  }

  public static generateJWT() {
    const privateKeyPath = path.join(process.cwd(), "private-key.pem");
    const privateKey = fs.readFileSync(privateKeyPath, "utf8");
    return jwt.sign(
      {
        iss: this.SALESFORCE_CLIENT_ID,
        sub: this.SALESFORCE_USERNAME,
        aud: this.SALESFORCE_LOGIN_URL,
        exp: Math.floor(Date.now()) * 10,
      },
      privateKey,
      { algorithm: "RS256" },
    );
  }

  /**
   * Reuses the last token until it ages out. Without this, a 5000-account sync
   * would mint ~50 tokens (one per composite call) and burn Salesforce API
   * request quota on auth alone.
   */
  public static getAccessToken = async (forceRefresh = false) => {
    if (
      !forceRefresh &&
      this.cachedToken &&
      Date.now() < this.cachedTokenExpiresAt
    ) {
      return this.cachedToken;
    }

    try {
      const jwtToken = this.generateJWT();
      const response = await axios.post(
        this.SALESFORCE_LOGIN_URL + "/services/oauth2/token",
        new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwtToken,
        }),
      );
      this.cachedToken = response.data.access_token;
      this.cachedTokenExpiresAt = Date.now() + SALESFORCE_TOKEN_TTL_MS;
      return this.cachedToken;
    } catch (error) {
      this.cachedToken = null;
      this.cachedTokenExpiresAt = 0;
      console.log({ error });
      return;
    }
  };

  /** Escapes a value for interpolation into a quoted SOQL string literal. */
  public static escapeSoql(value: string): string {
    return String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
  }

  private static isUnauthorized(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 401;
  }

  /**
   * A 400 means Salesforce rejected the request itself — an unknown field, an
   * unparseable value — rather than the org being unavailable. For a collection
   * call that fails every record in it, so the caller can narrow down which record
   * is at fault instead of writing the whole batch off.
   */
  public static isBadRequest(error: unknown): boolean {
    return axios.isAxiosError(error) && error.response?.status === 400;
  }

  /**
   * Salesforce puts the useful part of a request-level rejection in the response
   * body, which axios flattens to "Request failed with status code 400". This digs
   * the error code and message back out so failure logs are actionable.
   */
  public static describeError(error: unknown): string {
    if (axios.isAxiosError(error) && error.response?.data) {
      const body = error.response.data as
        | ISalesforceRequestError
        | ISalesforceRequestError[];
      const detail = (Array.isArray(body) ? body : [body])
        .map((entry) => {
          const code = entry?.errorCode || entry?.statusCode || "";
          const message = entry?.message || "";
          const fields = entry?.fields?.length
            ? ` [${entry.fields.join(", ")}]`
            : "";
          return [code, message].filter(Boolean).join(": ") + fields;
        })
        .filter((line) => line.trim())
        .join("; ");

      if (detail) return `HTTP ${error.response.status} ${detail}`;
    }

    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Runs a Salesforce REST call with the cached token, re-minting once on 401 so
   * a session that expired mid-sync doesn't fail the whole batch.
   */
  private static async requestWithToken<T>(
    call: (token: string) => Promise<T>,
  ): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) throw new Error("Failed to obtain Salesforce access token");

    try {
      return await call(token);
    } catch (error) {
      if (!this.isUnauthorized(error)) throw error;

      const refreshed = await this.getAccessToken(true);
      if (!refreshed) {
        throw new Error("Failed to refresh Salesforce access token after 401");
      }
      return call(refreshed);
    }
  }

  /** Runs SOQL, following `nextRecordsUrl` until every page is collected. */
  public static async query<T>(soql: string): Promise<T[]> {
    const records: T[] = [];
    let nextUrl: string | undefined;

    do {
      const page = await this.requestWithToken((token) =>
        axios.get<ISalesforceQueryResponse<T>>(
          nextUrl
            ? `${this.SALESFORCE_INSTANCE_URL}${nextUrl}`
            : `${this.dataUrl}/query`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: nextUrl ? undefined : { q: soql },
          },
        ),
      );

      records.push(...(page.data?.records || []));
      nextUrl = page.data?.done ? undefined : page.data?.nextRecordsUrl;
    } while (nextUrl);

    return records;
  }

  private static assertBatchSize(records: unknown[]): void {
    if (records.length > SALESFORCE_COMPOSITE_BATCH_SIZE) {
      throw new Error(
        `Salesforce composite requests accept at most ${SALESFORCE_COMPOSITE_BATCH_SIZE} records, got ${records.length}`,
      );
    }
  }

  /**
   * Updates up to 200 records per call by Salesforce record Id. The endpoint is
   * sObject-agnostic — each record names its own type — so a batch can mix Leads
   * and the Contacts that converted leads became. `allOrNone: false` keeps one
   * bad record from rolling back the batch; per-record outcomes come back
   * positionally in the response.
   */
  public static async updateRecordsById(
    records: ISalesforceCompositeRecord[],
  ): Promise<ISalesforceCompositeResult[]> {
    if (!records.length) return [];
    this.assertBatchSize(records);

    const response = await this.requestWithToken((token) =>
      axios.patch<ISalesforceCompositeResult[]>(
        `${this.dataUrl}/composite/sobjects`,
        { allOrNone: false, records },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      ),
    );

    return response.data || [];
  }

  /**
   * Creates up to 200 Leads per call. The returned results carry the new record
   * Ids positionally, which the caller persists so the lead never needs to be
   * looked up again.
   */
  public static async createLeadsBulk(
    records: ISalesforceLeadRecord[],
  ): Promise<ISalesforceCompositeResult[]> {
    if (!records.length) return [];
    this.assertBatchSize(records);

    const response = await this.requestWithToken((token) =>
      axios.post<ISalesforceCompositeResult[]>(
        `${this.dataUrl}/composite/sobjects`,
        { allOrNone: false, records },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      ),
    );

    return response.data || [];
  }

  public static createLead = async (leadData: ICreateLead) => {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      const error = new Error("Failed to obtain Salesforce access token");
      await this.sendLeadErrorNotification(
        "Creation",
        leadData.Email,
        error,
        leadData,
      );
      return;
    }

    try {
      const response = await axios.post(
        `${this.dataUrl}/sobjects/Lead`,
        leadData,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      );
      return response.data;
    } catch (error) {
      await this.sendLeadErrorNotification(
        "Creation",
        leadData.Email,
        error,
        leadData,
      );
      return;
    }
  };

  public static updateLead = async (leadId: string, leadData: ICreateLead) => {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return;

    try {
      // Update existing lead
      await axios.patch(`${this.dataUrl}/sobjects/Lead/${leadId}`, leadData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
    } catch (error) {
      return;
    }
  };

  // Updates an existing lead found by its current (old) email. Unlike
  // findAndUpdateLead, it never creates a lead on miss — used when a user changes
  // their email/phone, so we don't spawn spurious leads for non-lead users.
  public static updateLeadContact = async (
    lookupEmail: string,
    leadData: Partial<ICreateLead>,
  ) => {
    const accessToken = await this.getAccessToken();
    if (!accessToken || !lookupEmail) return;

    // Escape backslashes before quotes so a "\" can't escape our quote-escape;
    // both are reserved in SOQL string literals.
    const escapedEmail = lookupEmail
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");

    try {
      const response = await axios.get(
        `${this.SALESFORCE_INSTANCE_URL}/services/data/v62.0/query`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            q: `SELECT Id FROM Lead WHERE Email = '${escapedEmail}' LIMIT 1`,
          },
        },
      );

      if (response?.data?.records?.length > 0) {
        const leadId = response.data.records[0].Id;
        await this.updateLead(leadId, leadData as ICreateLead);
      }
    } catch (error) {
      return;
    }
  };

  public static findAndUpdateLead = async (leadData: ICreateLead) => {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return;

    try {
      const response = await axios.get(`${this.dataUrl}/query`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          q: `SELECT Id FROM Lead WHERE Email = '${this.escapeSoql(leadData.Email)}' LIMIT 1`,
        },
      });

      if (response?.data?.records?.length > 0) {
        const leadId = response.data.records[0].Id;
        await this.updateLead(leadId, leadData);
      } else {
        await this.createLead(leadData);
      }
    } catch (error) {
      return;
    }
  };

  public static findleadId = async (userId: ObjectIdType, email: string) => {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return;

    try {
      const response = await axios.get(`${this.dataUrl}/query`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          q: `SELECT Id FROM Lead WHERE Email = '${this.escapeSoql(email)}' LIMIT 1`,
        },
      });

      let success = 0,
        fail = 0;

      if (response?.data?.records?.length > 0) {
        const leadId = response.data.records[0].Id;
        await User.findByIdAndUpdate(userId, {
          $set: { salesforceLeadId: leadId },
        });
        success++;
      } else {
        fail++;
      }

      console.log({ success, fail });
    } catch (error) {
      return;
    }
  };
}
