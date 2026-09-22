import {
  CloudWatchClient,
  PutDashboardCommand,
  PutMetricAlarmCommand,
  PutMetricAlarmCommandInput,
} from "@aws-sdk/client-cloudwatch";
import { config } from "../../utils/configuration/config";

// Builds + applies the ES read-path operational CloudWatch dashboard and its alarms. OPERATOR-INVOKED (node scripts/deploySearchDashboard.js), not part of the ECR deploy pipeline — there is no dashboard/alarm IaC in this repo, the infra lives out-of-repo. The dashboard JSON (buildDashboardBody) is the versioned artifact. ES-rate panels + alarms read the CrewCam/Search custom metrics; cluster/JVM alarms read the AWS-managed AWS/ES namespace built-ins the OpenSearch domain publishes automatically.

const NAMESPACE = "CrewCam/Search";
const AWS_ES_NAMESPACE = "AWS/ES";
const DASHBOARD_NAME = "CrewCam-Search-ReadPath";

// Migrated ES read routes (match the searchWithFallback route keys + the metric `route` dimension).
const ROUTES = ["projects.list", "posts.uploads"];
// Index alias names carried on the indexing_lag `index` dimension.
const INDICES = ["projects", "posts_uploads"];

// Operator runbook; this file only embeds the anchor pointers.
const RUNBOOK = "docs/search-runbook.md";
const runbookUrl = (anchor: string): string => `${RUNBOOK}#${anchor}`;

type CwMetric = (string | { [k: string]: string | number | boolean })[];

// One time-series metric widget.
const metricWidget = (
  title: string,
  metrics: CwMetric[],
  region: string,
  y: number,
  width = 12,
): Record<string, unknown> => ({
  type: "metric",
  x: 0,
  y,
  width,
  height: 6,
  properties: { title, view: "timeSeries", stacked: false, region, metrics },
});

// query_latency p50/p95/p99 for one route.
const latencyWidget = (route: string, region: string, y: number) =>
  metricWidget(
    `ES query latency — ${route}`,
    [
      [
        NAMESPACE,
        "query_latency",
        "route",
        route,
        { stat: "p50", label: "p50" },
      ],
      [
        NAMESPACE,
        "query_latency",
        "route",
        route,
        { stat: "p95", label: "p95" },
      ],
      [
        NAMESPACE,
        "query_latency",
        "route",
        route,
        { stat: "p99", label: "p99" },
      ],
    ],
    region,
    y,
  );

// ES error rate % for one route: 100 * errors / (errors + successes), where successes = the query_latency sample count (one sample per successful ES call).
const errorRateWidget = (route: string, region: string, y: number) =>
  metricWidget(
    `ES error rate % — ${route}`,
    [
      [{ expression: "100*e/(e+s)", label: "error rate %", id: `er_${y}` }],
      [
        NAMESPACE,
        "query_errors",
        "route",
        route,
        { stat: "Sum", id: "e", visible: false },
      ],
      [
        NAMESPACE,
        "query_latency",
        "route",
        route,
        { stat: "SampleCount", id: "s", visible: false },
      ],
    ],
    region,
    y,
  );

// Mongo fallback rate % for one route: 100 * fallbacks / (fallbacks + ES successes).
const fallbackRateWidget = (route: string, region: string, y: number) =>
  metricWidget(
    `Mongo fallback rate % — ${route}`,
    [
      [{ expression: "100*f/(f+s)", label: "fallback rate %", id: `fr_${y}` }],
      [
        NAMESPACE,
        "mongo_fallback",
        "route",
        route,
        { stat: "Sum", id: "f", visible: false },
      ],
      [
        NAMESPACE,
        "query_latency",
        "route",
        route,
        { stat: "SampleCount", id: "s", visible: false },
      ],
    ],
    region,
    y,
  );

// Build the full CloudWatch dashboard body (the versioned JSON artifact). `companyId` is exposed as a dashboard variable so every chart can be filtered to one company; the default view is all-companies aggregate.
export const buildDashboardBody = (
  region: string = config.S3_BUCKET_REGION,
): Record<string, unknown> => {
  const widgets: Record<string, unknown>[] = [];
  let y = 0;
  // Per-route ES latency, error rate, fallback rate.
  ROUTES.forEach((route) => {
    widgets.push(latencyWidget(route, region, y));
    widgets.push(errorRateWidget(route, region, y + 6));
    widgets.push(fallbackRateWidget(route, region, y + 12));
    y += 18;
  });
  // Indexing lag p99 per index.
  widgets.push(
    metricWidget(
      "Indexing lag p99 per index",
      INDICES.map((index) => [
        NAMESPACE,
        "indexing_lag",
        "index",
        index,
        { stat: "p99", label: index },
      ]),
      region,
      y,
    ),
  );
  // Cluster status gauge (0 green / 1 yellow / 2 red) — single-value widget.
  widgets.push({
    type: "metric",
    x: 12,
    y,
    width: 6,
    height: 6,
    properties: {
      title: "Cluster status (0 green / 1 yellow / 2 red)",
      view: "singleValue",
      region,
      metrics: [[NAMESPACE, "cluster_status", { stat: "Maximum" }]],
    },
  });

  return {
    // Stratify any chart by a single companyId (default = all companies aggregated).
    variables: [
      {
        type: "property",
        property: "companyId",
        inputType: "input",
        id: "companyId",
        label: "Company ID (blank = all)",
        visible: true,
      },
    ],
    widgets,
  };
};

// Build the four alarms. ES error/fallback rates use CrewCam/Search metric-math; cluster-red + JVM-heap read the AWS/ES built-ins (DomainName dim). `snsArn` empty → alarms are created WITHOUT actions (operator wires SNS→PagerDuty out-of-repo). Sustained 5 min = Period 60 × 5 periods.
export const buildSearchAlarms = (
  snsArn: string,
  domainName: string,
): PutMetricAlarmCommandInput[] => {
  const actions = snsArn ? [snsArn] : [];
  // AWS/ES built-ins (ClusterStatus.red, JVMMemoryPressure) are published with BOTH DomainName AND ClientId (the AWS account id); an alarm whose dims don't match never resolves data. Derive the account id from the SNS ARN (arn:aws:sns:<region>:<account>:<topic>). Without it (or a DomainName) the two AWS/ES alarms are SKIPPED rather than created dimensionally-dead.
  const accountId = snsArn.split(":")[4] || "";
  const alarms: PutMetricAlarmCommandInput[] = [];

  ROUTES.forEach((route) => {
    // ES error rate > 1%.
    alarms.push({
      AlarmName: `CrewCam-Search-ESErrorRate-${route}`,
      AlarmDescription: `ES error rate > 1% (5m) on ${route}. Runbook: ${runbookUrl(
        "es-error-rate-alert-response",
      )}`,
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 1,
      EvaluationPeriods: 5,
      // Idle route (e+s=0 → metric-math no-data) reads OK, not INSUFFICIENT_DATA.
      TreatMissingData: "notBreaching",
      AlarmActions: actions,
      Metrics: [
        {
          Id: "er",
          Expression: "100*e/(e+s)",
          Label: `ES error rate % (${route})`,
          ReturnData: true,
        },
        {
          Id: "e",
          MetricStat: {
            Metric: {
              Namespace: NAMESPACE,
              MetricName: "query_errors",
              Dimensions: [{ Name: "route", Value: route }],
            },
            Period: 60,
            Stat: "Sum",
          },
          ReturnData: false,
        },
        {
          Id: "s",
          MetricStat: {
            Metric: {
              Namespace: NAMESPACE,
              MetricName: "query_latency",
              Dimensions: [{ Name: "route", Value: route }],
            },
            Period: 60,
            Stat: "SampleCount",
          },
          ReturnData: false,
        },
      ],
    });

    // Mongo fallback rate > 5%.
    alarms.push({
      AlarmName: `CrewCam-Search-MongoFallbackRate-${route}`,
      AlarmDescription: `Mongo fallback rate > 5% (5m) on ${route}. Runbook: ${runbookUrl(
        "mongo-fallback-rate-alert-response",
      )}`,
      ComparisonOperator: "GreaterThanThreshold",
      Threshold: 5,
      EvaluationPeriods: 5,
      TreatMissingData: "notBreaching",
      AlarmActions: actions,
      Metrics: [
        {
          Id: "fr",
          Expression: "100*f/(f+s)",
          Label: `Mongo fallback rate % (${route})`,
          ReturnData: true,
        },
        {
          Id: "f",
          MetricStat: {
            Metric: {
              Namespace: NAMESPACE,
              MetricName: "mongo_fallback",
              Dimensions: [{ Name: "route", Value: route }],
            },
            Period: 60,
            Stat: "Sum",
          },
          ReturnData: false,
        },
        {
          Id: "s",
          MetricStat: {
            Metric: {
              Namespace: NAMESPACE,
              MetricName: "query_latency",
              Dimensions: [{ Name: "route", Value: route }],
            },
            Period: 60,
            Stat: "SampleCount",
          },
          ReturnData: false,
        },
      ],
    });
  });

  // Cluster health red + JVM heap — AWS/ES built-ins. They resolve ONLY against the published DomainName + ClientId(account) dims; skip (don't create dimensionally-dead alarms) when either is missing.
  if (accountId && domainName) {
    const esDims = [
      { Name: "DomainName", Value: domainName },
      { Name: "ClientId", Value: accountId },
    ];
    alarms.push({
      AlarmName: "CrewCam-Search-ClusterStatusRed",
      AlarmDescription: `OpenSearch cluster status RED (5m). Runbook: ${runbookUrl(
        "cluster-red-alert-response",
      )}`,
      Namespace: AWS_ES_NAMESPACE,
      MetricName: "ClusterStatus.red",
      Dimensions: esDims,
      Statistic: "Maximum",
      Period: 60,
      EvaluationPeriods: 5,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: actions,
    });
    alarms.push({
      AlarmName: "CrewCam-Search-JVMHeapPressure",
      AlarmDescription: `OpenSearch JVM heap pressure > 80% (5m). Runbook: ${runbookUrl(
        "jvm-heap-pressure-alert",
      )}`,
      Namespace: AWS_ES_NAMESPACE,
      MetricName: "JVMMemoryPressure",
      Dimensions: esDims,
      Statistic: "Maximum",
      Period: 60,
      EvaluationPeriods: 5,
      Threshold: 80,
      ComparisonOperator: "GreaterThanThreshold",
      TreatMissingData: "notBreaching",
      AlarmActions: actions,
    });
  }

  return alarms;
};

const getClient = (): CloudWatchClient =>
  new CloudWatchClient({
    region: config.S3_BUCKET_REGION,
    credentials: {
      accessKeyId: config.S3_USER_KEY,
      secretAccessKey: config.S3_USER_SECRET,
    },
  });

// Operator entry point: apply the dashboard + the four alarms. Idempotent (PutDashboard / PutMetricAlarm overwrite by name). Skips alarm actions (with a clear log) when no SNS ARN is configured — the SNS topic + PagerDuty subscription are provisioned out-of-repo.
export const deploySearchDashboard = async (): Promise<void> => {
  const client = getClient();
  const snsArn = config.SEARCH_ALARM_SNS_TOPIC_ARN || "";
  const domainName = config.OPENSEARCH_DOMAIN_NAME || "";

  if (!snsArn) {
    console.warn(
      "⚠️  SEARCH_ALARM_SNS_TOPIC_ARN not set — alarms will be created WITHOUT paging actions. Wire the SNS→PagerDuty topic out-of-repo, then re-run.",
    );
  }
  if (!domainName || !snsArn) {
    console.warn(
      "⚠️  OPENSEARCH_DOMAIN_NAME and/or SEARCH_ALARM_SNS_TOPIC_ARN not set — the cluster-red and JVM-heap alarms (AWS/ES, which need DomainName + the ClientId/account-id derived from the SNS ARN) are SKIPPED. Set both and re-run to create them.",
    );
  }

  await client.send(
    new PutDashboardCommand({
      DashboardName: DASHBOARD_NAME,
      DashboardBody: JSON.stringify(buildDashboardBody()),
    }),
  );
  console.log(`✅ Put dashboard ${DASHBOARD_NAME}`);

  const alarms = buildSearchAlarms(snsArn, domainName);
  for (const alarm of alarms) {
    await client.send(new PutMetricAlarmCommand(alarm));
    console.log(`✅ Put alarm ${alarm.AlarmName}`);
  }
};
