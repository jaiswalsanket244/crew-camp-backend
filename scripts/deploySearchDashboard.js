// CLI wrapper: deploy the ES read-path operational CloudWatch dashboard + alarms.
//
//   node scripts/deploySearchDashboard.js
//
// Requires the COMPILED output in server/ (run `tsc` first). The transitive config import loads
// .env via its own dotenv.config(), so no env wiring here. OPERATOR-INVOKED — NOT part of the ECR
// deploy pipeline. SEARCH_ALARM_SNS_TOPIC_ARN + OPENSEARCH_DOMAIN_NAME come from env; alarm paging
// actions are skipped (with a warning) when the SNS ARN is absent (SNS→PagerDuty is wired
// out-of-repo). This wrapper never imports @aws-sdk/client-cloudwatch directly — the boundary stays
// inside lib/search/.

const main = async () => {
  const {
    deploySearchDashboard,
  } = require("../server/search/cli/searchDashboard");
  await deploySearchDashboard();
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {};
