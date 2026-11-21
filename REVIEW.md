# Review rules

These rules are the second layer of an independent review in Bellwood. The first layer is the general checklist in `src/shared/review.ts`, and it runs on every review. A rule here runs only when the PR changes a path that its `Trigger:` names.

## Read this file from main

Reviewers read the copy on `main`, never the copy on the branch under review:

```sh
git fetch origin main
git show origin/main:REVIEW.md    # without an origin remote: git show main:REVIEW.md
```

A PR that edits `REVIEW.md` cannot change the rules it is reviewed against. If `main` has no `REVIEW.md`, skip this layer.

## Match rules by path

1. List the changed files with `git diff --name-only origin/main...HEAD`.
2. A rule applies when at least one changed file matches one of its `Trigger:` patterns. `*` matches inside one path segment. `**` matches any number of directories.
3. For each rule that applies, do what its `Check:` line says. Skip the rest. If no rule applies, skip this layer.
4. In the hand-off, list the rules that applied.

## Grade every finding

Start each finding in the report's "问题" field with one tag:

- `[Important]`: a real crash, a security or sandbox escape, data loss or corruption, or a broken contract between two components. Only an `[Important]` finding can make the verdict `FAIL`.
- `[Nit]`: naming, style, or a small detail. The verdict is `PASS+NOTES`, never `FAIL`.
- `[Pre-existing]`: the problem is already on `main` and this PR did not add it. It never blocks the PR.

A follow-up review (round 2 or later) checks the open `[Important]` findings from the last round and the diff since the last reviewed commit. It does not review untouched files again. After 3 rounds with an open `[Important]`, stop and hand the decision to a person.

## Add or remove a rule

- Add a rule only when the same mistake showed up in at least 2 PRs and a reviewer can spot it from the diff.
- Each rule has a `Trigger:` line, a `Check:` line, and a `Seen in:` line with the commits that fixed the mistake.
- Delete a rule when the code it guards is gone or a test now catches the mistake. Prune stale rules when you add a new one.

## Rules

### Worker sandboxes keep the data directory out of reach

Trigger: `src/daemon/driver/write-scope.ts`, `src/shared/write-scope.ts`, `src/shared/readonly-policy.ts`, `src/daemon/platform/**`, `apps/windows/crates/fusa-win-helper/**`, `scripts/linux-sandbox-setup.sh`

Check: Normal and read-only Workers still cannot read `state/` (tokens, keys, the database, memory, logs, backups, other sessions' launch directories) or connect to `run/admin.sock`, on macOS, Linux `bwrap`, and Windows alike. If the deny list cannot be built, the launch fails instead of running without it. The PR runs `src/shared/write-scope.test.ts`, and a `bwrap` or Windows change has its cloud job green.

Seen in: `c2806c41`/`18936aa8`, `c6eb1731`/`638516a7`

### Vendor launch arguments never widen the permission tier

Trigger: `src/vendors/*/protocol.ts`, `src/vendors/*/driver.ts`, `src/vendors/*/spec.ts`, `src/vendors/*/capabilities.ts`

Check: No per-call or RPC argument (for example codex `sandbox` or `sandboxPolicy`, an approval mode, an extra writable directory) overrides the permission profile chosen for a read-only or normal Worker. Launch arguments stay in `src/vendors/<vendor>/`.

Seen in: `ab03a38d`/`af3b76c8`, `638516a7`

### Read-only Workers never reach a write-capable MCP tool

Trigger: `src/vendors/*/driver.ts`, `src/vendors/*/spec.ts`, `src/vendors/_common/acp/**`, `src/shared/readonly-policy.ts`

Check: Every MCP tool call a read-only Worker makes either passes through `connectorToolAllowed` (directly or via the ACP permission gate) or cannot happen because the vendor never loads an MCP server. A vendor mode that auto-approves tools (Kimi `yolo`, an OpenCode allow-all agent) hides every MCP source it reads, including user, project, plugin, and overridden-home config, and its MCP OAuth tokens. Read-only rules also win over agent-level permissions in user or project config, and delegation to subagents is denied. A test or a real-CLI run shows a non-read-only MCP tool is not executed.

Seen in: `bdb85632`, `c067de52`/`2a421897`, `717eeb06`

### Async work stops touching the ledger after shutdown starts

Trigger: `src/daemon/agent-api/**`, `src/daemon/sent-files.ts`, `src/daemon/ledger/**`, `src/daemon/feishu/**`, `src/daemon/daemon.ts`

Check: After each `await` in a handler or background job, the code checks `signal.aborted` (or the closing flag) before it calls the ledger or the database. `close()` cancels in-flight work and waits for handlers before the database closes. A slot for an open file or upload counts from open until the handle closes.

Seen in: `c69b3b94`, `d23209c2`/`796273fe`, `e5b55fa6`, `2bdf6ff9`/`3ecff0d4`

### Database transactions stay synchronous

Trigger: `src/daemon/store/**`, `src/daemon/ledger/**`, `src/daemon/sent-files.ts`

Check: A `db.transaction` callback has no `await`, no child process, and no file or network I/O. Copy files and probe git outside the transaction. A nested `db.transaction` is a `SAVEPOINT`, so code that catches an inner error must not assume the inner writes survived.

Seen in: `34152ae7`/`bfa21de2`, `4f7c6898`/`52f256ad`

### Caches key on identity, have a limit, and retry failures soon

Trigger: `src/daemon/commands-catalog.ts`, `src/daemon/driver/model-catalog.ts`, `src/daemon/skill-files.ts`, `src/daemon/ledger/loaded-skills.ts`, `src/daemon/platform/win32/**`, `src/daemon/quota/**`, `src/shared/paths.ts`, `src/shared/limits.ts`, `src/web/*-model.ts`

Check: A cache over files or directories keys on identity from `stat` (device, inode, mtime) or the SID, so a deleted and recreated directory misses. Every `LRUCache` and map has a `max` from `src/shared/limits.ts`. A failed or empty result, including a failed React Query fetch, is kept only for a short backoff such as `FETCHED_QUOTA_RETRY_MS`, never as a normal result. If an in-flight call can see its target replaced, the code checks the target again when the call returns.

Seen in: `43d70fad`, `18e2fa2b`/`7df95c32`, `8023745a`/`edcac7bb`, `50ac3399`

### Growing data has a cap in limits.ts

Trigger: `src/daemon/ledger/**`, `src/daemon/feishu/**`, `src/daemon/ui-server/**`, `src/daemon/*checker*.ts`, `src/shared/snapshot.ts`, `src/shared/limits.ts`

Check: Queues, in-memory collections, API responses, and command output that grow over time have a cap from `src/shared/limits.ts`. Size the cap for one month of use (300 finished Workers, 30,000 messages, 50,000 step logs). Large responses use compression. An external HTTP body is read as a stream and cancelled once it passes its byte cap, since `Content-Length` can be missing.

Seen in: `2bdf6ff9`, `eb0386bd`, `4ba0f65d`, `50b3d57a`

### Front-end selectors return stable references

Trigger: `src/web/selectors.ts`, `src/web/shell-model.ts`, `src/web/device-hub.ts`, `src/web/**/use*.ts`, `src/web/**/use*.tsx`

Check: A selector or hook returns the same reference while its input is unchanged, for example through a `WeakMap` keyed on the input object, so it does not break `memo` in child components. A new selector has a case in `src/web/selectors-cache.test.ts`.

Seen in: `43d70fad`, `473db164`, `0fc0e181`

### Stale in-flight queries never overwrite fresh mutations

Trigger: `src/web/**`

Check: When a manual refresh or save writes its result into the React Query cache, a monotonic generation counter or an entity version guards the write, so an automatic GET that was in flight, or that read the old server cache, cannot land later and replace the newer result. The guard never compares wall-clock timestamps, because the daemon clock can move backward and a restart resets it. Use the shared `queryGenerationOf` or `guardedQueryFn` from `src/web/query-client.ts`; `src/web/query-write-guard.test.ts` fails when a new module writes the cache without them, but it cannot tell whether every write path advances the generation.

Seen in: `2c3ff071`, `c58bac01`/`73e911b0`, `755269d9`

### Interface changes come with a real-browser render

Trigger: `src/web/components/**`, `src/web/ui/**`, `src/web/styles.css`, `src/web/mobile/**`

Check: The PR shows the changed screen rendered in a real browser (`pnpm verify`, `pnpm ui:polish`, or a Playwright screenshot), not only jsdom tests. Spacing, radius, type size, color, and focus states follow `docs/ui-standard.md`.

Seen in: `0fc0e181`, `a55ca6f0`

### The relay trusts only CF-Connecting-IP and resists flushing

Trigger: `src/relay/**`

Check: The client address for rate limits comes from `CF-Connecting-IP`, not `X-Forwarded-For` or the socket. Rate-limit tables have a size limit, and a flood of one-time keys cannot evict the counters of clients that are still counting. The Node and Cloudflare entries share the logic in `src/relay/guards.ts`.

Seen in: `aab84d31`, `09a530ca`/`72abdf7c`

### Feishu code goes through transport.ts

Trigger: `src/daemon/feishu/**`

Check: Only `src/daemon/feishu/sdk.ts` imports `@larksuiteoapi/node-sdk`. Other modules depend on `src/daemon/feishu/transport.ts`. The inbound catch-up cursor moves forward only after the message is handled.

Seen in: `f294936b`/`a4d5ca8d`, `5a2a2f03`

### Child processes are tracked and gone before cleanup

Trigger: `src/daemon/driver/**`, `src/daemon/handover/**`, `src/daemon/setup/**`, `src/daemon/process-ledger.ts`, `test/e2e/harness.ts`, `test/spawn-guard.ts`, `test/smoke/**`

Check: Each new child process the daemon starts goes through `trackChild`, so a crash leaves nothing behind after the next start. A test stops the daemon and waits for it and its children to exit before it deletes the temporary `AGENT_HUB_HOME`. Never use `rmSync` retries or `gh run rerun` to hide `ENOTEMPTY`.

Seen in: `6af05c80`, `4b557b03`

### Tests wait for events, not for time

Trigger: `**/*.test.ts`, `**/*.test.tsx`, `test/**`

Check: A test that needs a child process or timer to reach some state awaits the event that proves it (a driver event, a log line, a file) or advances fake timers. It does not sleep a fixed time and hope the state arrives first. A test that formats or compares dates pins the clock with `vi.setSystemTime` instead of reading the wall clock. A per-test timeout leaves at least twice the slowest runtime seen on the CI runner that runs it. A test that needs something a Worker sandbox forbids, such as running the setuid `/bin/ps` or nesting `sandbox-exec` on macOS, probes for it and uses `it.skipIf`, so it never fails only on a Worker machine.

Seen in: `12633961`, `d82bae28`, #397

### Hub error codes change on both sides

Trigger: `src/shared/errors.ts`, `src/shared/hub.ts`, `src/shared/ledger.ts`, `src/hub/**`

Check: A new error code has an HTTP status in `LEDGER_ERROR_HTTP_STATUS`, user-facing text, and handling in both the daemon and the `hub` command. The status table test covers it.

Seen in: `c69b3b94`, `d91bb4d1`
