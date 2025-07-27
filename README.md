# 🗂️ Database Setup: Migrations & Seeds with Knex

## 📁 Folder Structure

Make sure you have the following folder structure:

```
api/
├── migrations/
│   └── [timestamp]_init_schema.js
├── seeds/
│   └── seed_data.js
├── knexfile.js
├── src/
│   └── db.ts
```

---

## ✅ Step 1: Install Knex & PostgreSQL Driver

```bash
npm install knex pg
```

---

## ✅ Step 2: Create `knexfile.js`

This file tells Knex where to find your migration and seed files:

```js
// knexfile.js
require("dotenv").config();

module.exports = {
  production: {
    client: "pg",
    connection: process.env.DATABASE_URL,
    migrations: {
      directory: "./migrations"
    },
    seeds: {
      directory: "./seeds"
    }
  }
};
```

---

## ✅ Step 3: Create a Migration File

```bash
npx knex migrate:make init_schema --knexfile knexfile.js
```

Edit the file in `migrations/` and define your schema (e.g., `sections`, `content_items`, `url_items`, etc.).

---

## ✅ Step 4: Run the Migration

```bash
npx knex migrate:latest --knexfile knexfile.js
```

---

## ✅ Step 5: Create Seed Data

```bash
npx knex seed:make seed_data --knexfile knexfile.js
```

Then add dummy records in `seeds/seed_data.js`.

---

## ✅ Step 6: Run the Seed Script

```bash
npx knex seed:run --knexfile knexfile.js
```

---

## ❓ Should Migration & Seed Files Be in `.gitignore`?

**No**, they should **not** be ignored.

| File/Folder        | Include in Git? | Reason                                  |
|--------------------|------------------|------------------------------------------|
| `migrations/`       | ✅ Yes            | Defines your DB schema                   |
| `seeds/`            | ✅ Yes (optional) | Include if needed for dev/staging        |
| `knexfile.js`       | ✅ Yes            | Required by Knex to run migrations/seeds |
| `dist/`             | ❌ No             | This is your build output, should be in `.gitignore` |

If you don’t want seed data pushed to production, you can have separate seed files for dev vs. prod and run only the ones you want.