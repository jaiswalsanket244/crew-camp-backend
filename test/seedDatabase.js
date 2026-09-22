/*
******************************************************
This is for the future Reference to seed the database
******************************************************
*/

const chai = require("chai");
const chaiHttp = require("chai-http");
const mongoose = require("mongoose");
const utils = require("./utils");

chai.use(chaiHttp);

// Constants
const dbURI = process.env.DB_PATH;
const DATA_PATH = `test/data/auth.yml`;

describe("API TESTS", function () {
  describe("TESTS API", function () {
    beforeEach(async function () {
      await utils.seedDatabase(dbURI, DATA_PATH, null);
    });

    afterEach(async function () {
      const collections = await mongoose.connection.db.collections();

      for (let collection of collections) {
        await collection.deleteMany({});
      }
    });
  });
});
