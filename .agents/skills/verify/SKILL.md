---
name: verify
description: "Run the local end-to-end smoke check for Bellwood: build the web app, start a real daemon in a throwaway data directory, log in, render the workbench in headless Chromium, and shut everything down cleanly. Use before you hand off or review a change, together with typecheck and the related tests."
---

# Verify

`pnpm verify` proves the app still starts and renders on this machine. One run takes about 4 seconds and has a 20-second budget.

## Run it

```sh
pnpm verify              # one run
pnpm verify --runs 3     # three runs, with median and range
pnpm verify --out <dir>  # write the screenshot and timing log somewhere else
```

The command exits 0 only if every run passes. It writes two files to `/tmp/bellwood-verify-smoke/` by default:

- `workbench-smoke.png`: the rendered workbench.
- `smoke-runs.txt`: the time of each phase in each run, the median, and the range.

Look at the screenshot. A passing run with a wrong-looking screen is still a failure.

## What one run checks

`scripts/verify-smoke.ts` runs these steps in order and stops at the first failure:

1. Build the web app with `vite build`.
2. Start `src/daemon/main.ts` with a temporary `AGENT_HUB_HOME`, a temporary `HOME`, and a random free port. The default vendor is the fake claude from `test/fake-claude/`. Other vendors point at paths that do not exist, so no real CLI starts and your own config stays untouched.
3. Open the passwordless login link and expect a 302 with a session cookie.
4. Call `GET /api/health` and `GET /api/state` with that cookie.
5. Open the workbench in headless Chromium and wait for the composer. Any `console.error` or `pageerror` fails the run.
6. Stop the daemon the way the desktop shell does: `SIGTERM` on macOS and Linux, `POST /admin/shutdown` on Windows. The daemon must exit with code 0, and no child process it recorded in `state/child-processes.json` may still be alive.
7. Delete the temporary directory and check that it is gone.

## When to use it

- Before you push: run `pnpm typecheck`, `pnpm test:related`, and `pnpm verify`. After you push, wait for the PR's CI checks with `node scripts/wait-checks.ts <PR>` (or `node scripts/wait-checks.ts` on the PR branch) instead of `gh pr checks --watch`, so pending `bellwood/review` does not hang and merge conflicts fail immediately (`AGENTS.md`, "Cloud checks before done").
- In an independent review: run it on the commit under review.
- Changes to the Linux `bwrap` sandbox, Windows native code, or packaging cannot be tested here. The matching cloud job on the PR is their only test.

If a run fails, read the error line in `smoke-runs.txt` first. It names the step and includes the daemon's stderr when the daemon exits early. Never rerun a failed cloud job with `gh run rerun` to hide a flaky test. Report the flake as a finding.

## Extend it

Add a check to `runOnce` in `scripts/verify-smoke.ts` only if it is fast and catches a failure that unit tests miss. Keep a full run under `VERIFY_SMOKE_BUDGET_MS` in `src/shared/limits.ts`.
