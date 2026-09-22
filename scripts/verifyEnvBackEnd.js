const path = require("path");
const EXAMPLE_ENV_PATH = path.resolve(".", `.env.example`);
const ENV_PATH = path.resolve(
  ".",
  process.env.NODE_ENV === "test" ? ".env.spec" : ".env",
);
const dotenv = require("dotenv");
const fs = require("fs");
const loadEnv = () => {
  //parsing both env files
  const exampleEnv = dotenv.parse(fs.readFileSync(EXAMPLE_ENV_PATH));
  const env = dotenv.parse(fs.readFileSync(ENV_PATH));

  //checking missing values
  const missingFromEnv = difference(Object.keys(exampleEnv), Object.keys(env));
  const missingFromEnvExample = difference(
    Object.keys(env),
    Object.keys(exampleEnv),
  );

  showMessage(missingFromEnv, missingFromEnvExample);

  // Required OpenSearch env vars must be present and non-empty in non-test envs
  if (process.env.NODE_ENV !== "test") {
    // OPENSEARCH_REGION is now a code constant (config.ts), no longer an env var.
    const requiredOpenSearch = ["OPENSEARCH_ENDPOINT"];
    const missingRequired = requiredOpenSearch.filter((key) => !env[key]);
    if (missingRequired.length > 0) {
      console.log("\x1b[41m%s\x1b[0m", "  Env Check: Failed  ");
      console.log(
        "\x1b[33m%s\x1b[0m",
        "  Missing required OpenSearch env:",
        missingRequired,
      );
      console.log("\x1b[33m%s\x1b[0m", "  From:", ENV_PATH);
      console.log("");
      throw new Error("Missing required OpenSearch env vars!");
    }
  }
};

const difference = (arrA, arrB) => {
  return arrA.filter((a) => arrB.indexOf(a) < 0);
};

const showMessage = (missingFromEnv, missingFromEnvExample) => {
  console.log("");
  if (missingFromEnv.length > 0 || missingFromEnvExample.length > 0) {
    console.log("\x1b[41m%s\x1b[0m", "  Env Check: Failed  ");
    if (missingFromEnvExample.length > 0) {
      console.log("\x1b[33m%s\x1b[0m", "  Missing:", missingFromEnvExample);
      console.log("\x1b[33m%s\x1b[0m", "  From:", EXAMPLE_ENV_PATH);
      console.log("");
    }
    if (missingFromEnv.length > 0) {
      console.log("\x1b[33m%s\x1b[0m", "  Missing:", missingFromEnv);
      console.log("\x1b[33m%s\x1b[0m", "  From:", ENV_PATH);
      console.log("");
    }
    throw new Error("Check env files!");
  } else {
    console.log("\x1b[42m%s\x1b[0m", "  Env Check: Passed  ");
    console.log("");
  }
};

loadEnv();
