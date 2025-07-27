require("dotenv").config()
const knexConfig = require("./knexfile")
const knex = require("knex")(knexConfig.production)


module.exports = {
  production: {
    client: "pg",
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    },
    migrations: {
      directory: "./migrations"
    },
    seeds: {
      directory: "./seeds"
    }
  }
}
