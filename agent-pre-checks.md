# Agent runner pre-checks

**Date:** 2026-07-24
**Container user:** `node`
**Workspace:** `/workspace` (branch `grunt-task-432`)

This is an environment-verification report. Every check was run inside this
container; all scratch work happened under `/tmp` and has been cleaned up. The
only workspace change is this file.

---

## 1. Toolchain — PASS

| Tool | Command | Result |
|------|---------|--------|
| node | `node --version` | `v20.20.2` (expected v20.x ✓) |
| npm | `npm --version` | `10.8.2` |
| git | `git --version` | `git version 2.39.5` |
| python3 | `python3 --version` | `Python 3.11.2` |
| make | `make --version` | `GNU Make 4.3` |
| g++ | `g++ --version` | `g++ (Debian 12.2.0-14+deb12u1) 12.2.0` |

All toolchain binaries present; Node is on the expected v20 line. A C/C++
toolchain (g++ 12.2, make 4.3, python3) is available for native (node-gyp)
builds should a future dependency need one.

## 2. Postgres lifecycle — PASS

`initdb --version` → `initdb (PostgreSQL) 15.18 (Debian 15.18-0+deb12u1)`

Full throwaway-cluster cycle run as user `node`:

1. `initdb -D /tmp/pgtest` → **exit 0** (cluster created; local `trust` auth).
2. `pg_ctl -D /tmp/pgtest -o "-k /tmp -p 55432 -c listen_addresses=''" start`
   → **exit 0**, "server started". Log confirmed:
   `listening on Unix socket "/tmp/.s.PGSQL.55432"` — unix-socket only, no TCP.
3. `createdb -h /tmp -p 55432 testdb` → **exit 0**.
4. `psql -h /tmp -p 55432 -d testdb -c 'select version();'` → **exit 0**,
   returned `PostgreSQL 15.18 (Debian 15.18-0+deb12u1) ... 64-bit`.
5. `pg_ctl -D /tmp/pgtest stop` → **exit 0**, "server stopped".

The complete lifecycle works end-to-end over a unix socket in `/tmp`. Cluster
and data directory were removed after check 3.

## 3. npm install + native builds + pg client — PASS

In `/tmp/npmtest`:

- `npm init -y` → ok.
- `npm install pg typescript knex` → **added 39 packages, audited 40, in ~3s**,
  0 vulnerabilities. Install time ≈ **3 seconds** (registry cache warm; see
  check 7). Note: these three packages installed as pure JavaScript — no
  node-gyp/native compilation was triggered (`pg` uses its JS driver; the
  optional `pg-native` binding was not requested). The native toolchain from
  check 1 was therefore available but unexercised by this dependency set.
- pg client connectivity: a Node script using the `pg` package's `Client`
  connected over the unix socket (`host: '/tmp'`, `port: 55432`,
  `database: 'testdb'`, `user: 'node'`) and ran `SELECT 1` →
  **`PG_CLIENT_RESULT=[{"val":1}]`** (exit 0).
  - Gotcha recorded for future tasks: the `pg` client does **not** infer the
    DB role from the OS user the way `psql` does. Without an explicit `user`,
    connection fails with `no PostgreSQL user name specified in startup packet`.
    Set `user: 'node'` (or `PGUSER`) explicitly.
- `npx tsc --version` (from `/tmp/npmtest`) → **`Version 7.0.2`**.

Scratch dir `/tmp/npmtest` was removed. No `package.json`/`node_modules` was
created in `/workspace`.

## 4. Context mount (`/context/file-manager-api`) — PASS

Top-level layout (two levels deep, `node_modules`/git internals elided):

```
/context/file-manager-api
├── .env.example
├── .github/workflows
├── .gitignore
├── README.md
├── TASKS.md
├── __tests__/            (allowedUsersService, app, auth, fileService,
│                          filesRouter, folderService, foldersRouter,
│                          healthRouter, recycleBinRouter, s3Service,
│                          shareLinkRouter, sharingRouter, sharingService,
│                          uploadSweeper, userService, userSweeper *.test.ts)
├── docs/cdn-caching-strategy.md
├── dockerfile
├── index.ts
├── jest.config.cjs
├── knexfile.ts
├── package.json
├── package-lock.json
├── tsconfig.json
└── src/
    ├── app.ts
    ├── aws/
    ├── db/
    ├── interfaces.ts
    ├── middleware/
    ├── routers/
    ├── services/
    ├── types.ts
    └── utils/
```

**Readability:** `/context/file-manager-api/src/aws/s3Service.ts` is readable.
Its exported symbols:

- `buildS3Key`
- `initS3`
- `uploadObject`
- `deleteObject`
- `deleteObjects`
- `listObjectsByPrefix`
- `generatePresignedDownloadUrl`
- `headObject`
- `initiateMultipartUpload`
- `generatePresignedUploadPartUrl`
- `completeMultipartUpload`
- `listUploadedParts`
- `abortMultipartUpload`
- `getS3Client`
- `getBucketName`
- `generateSignedCloudFrontUrl`

**Read-only enforcement:** `touch /context/file-manager-api/.write-test`
**failed as expected** with
`touch: cannot touch '.../.write-test': Read-only file system` (exit 1); the
file was not created. Mount table confirms the 9p mount is flagged `ro`. This
expected failure is the PASS result — no cleanup was needed since nothing was
written.

## 5. Workspace git — PASS

- Current branch: `grunt-task-432` (matches `grunt-task-*` ✓).
- `git status` runs cleanly. At container start `README.md` showed a spurious
  1-line diff (identical text `# portfolio-v6-api` on both sides — a
  line-ending/whitespace artifact from the Windows (`C:\`, 9p) mount, not an
  edit by this agent). It was restored with `git checkout -- README.md` so that
  this report is the only workspace change.

## 6. Resources — PASS

- `df -h /` → overlay **1007G total, 12G used, 944G avail (2%)**.
- `df -h /workspace` → `C:\` **465G total, 101G used, 365G avail (22%)** (bind
  mount from the WSL2 Windows host).
- Memory: `free` is not installed; from `/proc/meminfo` →
  **MemTotal ≈ 11962 MB (~12 GB), MemAvailable ≈ 11030 MB, MemFree ≈ 6093 MB**.
- `nproc` → **8** CPUs.

Ample disk, ~12 GB RAM, and 8 cores — comfortable for parallel test runs and
local Postgres.

## 7. Network — PASS (registry) / AWS intentionally not tested

- `npm ping` → `PING https://registry.npmjs.org/` … `PONG 256ms`. The npm
  registry is reachable.
- **AWS was NOT contacted.** Per task instructions, AWS is expected to be
  unreachable from this container and no check attempted any AWS call. Future
  tasks must **not** depend on live AWS connectivity; anything touching the
  `s3Service`/CloudFront paths from the reference repo should be mocked or
  stubbed.

---

## Implications for future tasks

- **DB-backed tests are viable.** A throwaway PostgreSQL 15 cluster can be
  spun up as the `node` user over a unix socket in `/tmp` (initdb → pg_ctl
  start → createdb → query → stop all pass), and the `pg` Node client connects
  and queries it successfully. Suitable for `knex`-based integration tests
  against a local ephemeral database. Remember to pass an explicit DB `user`
  (`node`/`PGUSER`) to the `pg` client — unlike `psql`, it does not default to
  the OS user.
- **Reference code is readable.** `/context/file-manager-api` is mounted
  read-only and fully readable (source, tests, config), so it is usable as
  authoritative reference material. Writes to it fail with EROFS by design — do
  not attempt to modify it; make all changes in `/workspace`.
- **Toolchain is complete.** Node 20, npm 10, git, python3, make, and g++ are
  all present; native (node-gyp) builds are possible even though the pg/knex/
  typescript set did not require compilation. npm registry is reachable and
  fast (installs in seconds).
- **No AWS at runtime.** Do not build tasks that require live AWS/S3/CloudFront
  access from this container; mock those integrations.
- **Resources are generous:** 8 cores, ~12 GB RAM, hundreds of GB free on both
  `/` and `/workspace`.
