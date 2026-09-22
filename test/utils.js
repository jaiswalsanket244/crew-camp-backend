const dookie = require("@nishantsingh/dookie");
const fs = require("fs");
const yaml = require("js-yaml");

exports.seedDatabase = async function (dbURI, file, options) {
  let contents = fs.readFileSync(file);
  await dookie.push(dbURI, yaml.load(contents), options || null);
};
