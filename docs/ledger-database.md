# Ledger database

> Snapshot: 2026-11-22 (commit `5c426864`)

The daemon keeps all of its state in one SQLite file, `state/hub.sqlite` under the data directory. This page covers who may open that file, how schema migrations stay complete, and how upgrades from released versions are tested.

## The daemon owns the file

`openStore()` in `src/daemon/store/open.ts` opens the ledger with `PRAGMA locking_mode = EXCLUSIVE` and holds the lock until shutdown. No other process can read or write the file while the daemon runs.

The lock exists because `node:sqlite` is synchronous. When another process holds a write lock, every daemon write waits for it on the event loop, up to `DB_BUSY_TIMEOUT_MS` (5 seconds), and every HTTP request, WebSocket frame, and timer waits too. With a foreign 850 ms write lock, `GET /api/health` took about 800 ms. With the exclusive lock, the foreign process gets `database is locked` and the daemon never waits.

The lock has costs:

- A process that has the ledger open when the daemon starts blocks startup. The daemon waits up to 5 seconds, then exits with `ledger_locked` and names the file. Close the other program and start again.
- To read live data, stop the daemon first. The `hub.sqlite.bak-*` files are not live: the daemon writes one only before it runs migrations or rebuilds the file for `auto_vacuum`, so the newest one shows the ledger as it was before the last upgrade.
- End-to-end tests read the ledger and add triggers to it while the daemon runs, so `test/e2e/harness.ts` sets `AGENT_HUB_DB_SHARED_ACCESS=1`. Smoke scripts that call `startDaemon()` in-process get the same variable from `smokeDaemonEnv()` in `test/smoke/kit.ts`, and `test/smoke/ledger-access.test.ts` fails if one does not use it. With that variable the daemon opens the file in normal locking mode, and a foreign write lock stalls it again.

## Migrations and their manifest

`migrations/` holds numbered SQL files, `0001_init.sql` to the latest, and `manifest.sha256`. Each manifest line has the SHA-256 of one migration and its file name, in version order. It is the format `shasum -a 256` prints and `shasum -a 256 -c` checks.

Before `migrate()` runs anything, `loadMigrations()` checks the whole directory against the manifest. A missing file, an unlisted file, a renumbered or duplicated version, a gap, or changed file content stops startup, and no migration runs. Without this check, a package that lost `0044_capability_scopes.sql` upgraded a v0.2.0 ledger to version 47, skipped 0044 for good, and the daemon then failed on `no such table: router_capability_policies`.

To add a migration:

1. Run `node scripts/migration-claims.ts --next` from the repository root.
2. Write `migrations/<next version>_<name>.sql` with the printed number.
3. From `migrations/`, run `shasum -a 256 <file> >> manifest.sha256`. If you skip this step, the startup error prints the exact line to append.
4. If you edit the migration again before it merges, replace its line with a new checksum.

If two open PRs claim the same version, the `migration-claims` check fails on the PR with the higher PR number. It names the other PR and the next free version. Renumber the migration and update its manifest entry. If a lower migration number is still waiting to merge, the manifest check requires that migration to land first. Never edit, rename, or renumber a migration that is already on `main`: ledgers that ran the old file never run it again. Add a new migration instead.

### Triggers built from code

A trigger whose condition is defined in TypeScript, such as the step slot admission built from `HOLDS_SLOT_SQL`, is installed by the ledger each time it opens and is named with the `code_` prefix (`CODE_TRIGGER_PREFIX`). Before `migrate()` applies any migration it drops every `code_*` trigger, because SQLite refuses to rebuild a table that a trigger body reads, and older migrations rebuild `messages`, `workers`, and the task graph tables. Migration files may create triggers only when the trigger body reads tables that no earlier migration rebuilds.

## Upgrade tests with released ledgers

`test/fixtures/release-db/<tag>.sqlite.gz` holds a ledger that a released version really wrote. `scripts/release-db-fixture.ts` extracts the tag with `git archive` and starts that tag's daemon through that tag's e2e harness and fake vendor CLI. It then creates a project, chats with two PMs through the released API, and gzips the database the daemon leaves after a clean shutdown.

`test/e2e/release-upgrade.test.ts` runs in CI on every pull request. It runs the same checks on one more sample, which `captureSampleLedger()` from the same script writes with the working tree's daemon. That sample is already at the latest version, as the sample of a release without new migrations will be. For each sample, the test starts the current daemon on a copy and checks these results:

- If the sample is older than the latest migration, the daemon backs it up once, and the backup opens at the old `user_version`. A sample at the latest version gets no backup.
- The upgraded ledger reaches the latest version, passes `integrity_check` and `foreign_key_check`, and has exactly the schema of a fresh install.
- The API still serves the sample PMs, project, and replies, can archive and unarchive an old PM, and can create a PM and finish a chat turn.

After you tag a release, add its sample:

```sh
node scripts/release-db-fixture.ts vX.Y.Z
```

Commit the new `test/fixtures/release-db/vX.Y.Z.sqlite.gz` without changing older samples.
