# Ledger database

The daemon keeps all of its state in one SQLite file, `state/hub.sqlite` under the data directory. This page covers who may open that file, how schema migrations stay complete, and how upgrades from released versions are tested.

## The daemon owns the file

`openStore()` in `src/daemon/store/open.ts` opens the ledger with `PRAGMA locking_mode = EXCLUSIVE` and holds the lock until shutdown. No other process can read or write the file while the daemon runs.

The lock exists because `node:sqlite` is synchronous. When another process holds a write lock, every daemon write waits for it on the event loop, up to `DB_BUSY_TIMEOUT_MS` (5 seconds), and every HTTP request, WebSocket frame, and timer waits too. With a foreign 850 ms write lock, `GET /api/health` took about 800 ms. With the exclusive lock, the foreign process gets `database is locked` and the daemon never waits.

The lock has costs:

- A process that has the ledger open when the daemon starts blocks startup. The daemon waits up to 5 seconds, then exits with `ledger_locked` and names the file. Close the other program and start again.
- To inspect live data, read the newest `hub.sqlite.bak-*` backup, or stop the daemon first.
- End-to-end tests read the ledger and add triggers to it while the daemon runs, so `test/e2e/harness.ts` sets `AGENT_HUB_DB_SHARED_ACCESS=1`. With that variable the daemon opens the file in normal locking mode, and a foreign write lock stalls it again.

## Migrations and their manifest

`migrations/` holds numbered SQL files, `0001_init.sql` to the latest, and `manifest.sha256`. Each manifest line has the SHA-256 of one migration and its file name, in version order. It is the format `shasum -a 256` prints and `shasum -a 256 -c` checks.

Before `migrate()` runs anything, `loadMigrations()` checks the whole directory against the manifest. A missing file, an unlisted file, a renumbered or duplicated version, a gap, or changed file content stops startup, and no migration runs. Without this check, a package that lost `0044_capability_scopes.sql` upgraded a v0.2.0 ledger to version 47, skipped 0044 for good, and the daemon then failed on `no such table: router_capability_policies`.

To add a migration:

1. Write `migrations/<next version>_<name>.sql`.
2. From `migrations/`, run `shasum -a 256 <file> >> manifest.sha256`. If you skip this step, the startup error prints the exact line to append.
3. If you edit the migration again before it merges, replace its line with a new checksum.

Two pull requests that both take the next number append different lines to the end of `manifest.sha256`, so the second one to merge has a Git conflict. Resolve it by renumbering your migration. Never edit, rename, or renumber a migration that is already on `main`: ledgers that ran the old file never run it again. Add a new migration instead.

## Upgrade tests with released ledgers

`test/fixtures/release-db/<tag>.sqlite.gz` holds a ledger that a released version really wrote. `scripts/release-db-fixture.ts` extracts the tag with `git archive` and starts that tag's daemon through that tag's e2e harness and fake vendor CLI. It then creates a project, chats with two PMs through the released API, and gzips the database the daemon leaves after a clean shutdown.

`test/e2e/release-upgrade.test.ts` runs in CI on every pull request. For each sample, it starts the current daemon on a copy and checks these results:

- The daemon backs up the ledger, and the backup opens at the old `user_version`.
- The upgraded ledger reaches the latest version, passes `integrity_check` and `foreign_key_check`, and has exactly the schema of a fresh install.
- The API still serves the sample PMs, project, and replies, can archive and unarchive an old PM, and can create a PM and finish a chat turn.

After you tag a release, add its sample:

```sh
node scripts/release-db-fixture.ts vX.Y.Z
```

Commit the new `test/fixtures/release-db/vX.Y.Z.sqlite.gz` without changing older samples.
