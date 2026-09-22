import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws-v3";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { config } from "../utils/configuration/config";
import { GLOBAL_REQUEST_TIMEOUT_MS } from "./builders/timeouts";

// Single OpenSearch connection point for the whole backend; lib/search/ is the ONLY place that imports @opensearch-project/opensearch.
class SearchClientService {
  private static instance: Client;

  private constructor() {
    // Not instantiable — use SearchClientService.getInstance().
  }

  public static getInstance = (): Client => {
    if (!SearchClientService.instance) {
      // Staging cluster uses FGAC basic auth (username/password from Secrets Manager); production target uses sigv4 via the instance role.
      const hasUser = !!config.OPENSEARCH_USERNAME;
      const hasPass = !!config.OPENSEARCH_PASSWORD;

      // Fail fast on a partial credential set: exactly one of user/pass would silently fall through to sigv4 and fail far from here against the FGAC cluster (both-absent stays valid sigv4).
      if (hasUser !== hasPass) {
        throw new Error(
          "OpenSearch auth misconfigured: set BOTH OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD for basic auth, or NEITHER for sigv4",
        );
      }

      const useBasicAuth = hasUser && hasPass;
      // Log the chosen auth mode only — never the credentials.
      console.log("search client:", useBasicAuth ? "basic-auth" : "sigv4");

      if (useBasicAuth) {
        SearchClientService.instance = new Client({
          node: config.OPENSEARCH_ENDPOINT,
          auth: {
            username: config.OPENSEARCH_USERNAME,
            password: config.OPENSEARCH_PASSWORD,
          },
          requestTimeout: GLOBAL_REQUEST_TIMEOUT_MS,
        });
      } else {
        // sigv4 path (production target): build the credential provider chain once so the signer reuses the SDK's credential cache across refreshes. Role assumption is not wired here — today the sigv4 path relies on the ambient instance/task role via defaultProvider().
        const credentialsProvider = defaultProvider();
        SearchClientService.instance = new Client({
          ...AwsSigv4Signer({
            region: config.OPENSEARCH_REGION,
            service: "es",
            getCredentials: () => credentialsProvider(),
          }),
          node: config.OPENSEARCH_ENDPOINT,
          requestTimeout: GLOBAL_REQUEST_TIMEOUT_MS,
        });
      }
    }
    return SearchClientService.instance;
  };
}

export { SearchClientService };
