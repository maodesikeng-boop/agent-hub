---
name: verify
description: "Run the local end-to-end smoke check for Bellwood: build the web app, start a real daemon in a throwaway data directory, log in, render the workbench in headless Chromium, and shut everything down cleanly. Use before you hand off or review a change, together with typecheck and the related tests."
---

# Verify

`pnpm verify` proves the app still starts and renders on this machine. Three local runs on macOS arm64 took 10 to 12 seconds each. The script flags runs over its 20-second target.

## Run it

```sh
pnpm verify              # one run
pnpm verify --runs 3     # three runs, with median and range
pnpm verify --out <dir>  # write the screenshot and timing log somewhere else
pnpm verify --composer-layout # also check composer layout and interactions
```

The command exits 0 only if every run passes. It writes two files to `/tmp/bellwood-verify-smoke/` by default:

- `workbench-smoke.png`: the rendered workbench.
- `smoke-runs.txt`: the time of each phase in each run, the median, and the range.

Look at the screenshot. A passing run with a wrong-looking screen is still a failure.

The pull request smoke job installs WebKit and runs the composer check.
For local runs, install the browser with `pnpm exec playwright install webkit`.
The check types into the real composer and uses the WebKit timeline to count layout events.
It covers stable single-line typing and edits in the middle of a multiline draft.
It also checks that single-line edits lay out only the textarea. These checks do not depend on machine speed. jsdom cannot measure browser layout.
Chromium and WebKit also check that typing across the wrap boundary, deleting back to one row, pasting text, and composing text preserve the draft. The composition test uses browser events and does not start an OS input method.
WebKit checks the wrap boundary again with a coarse pointer at the Compact scale, the one scale where the textarea's 16px font floor applies.
The check writes `composer-layout.txt` and interaction screenshots under the same output directory.

## What one run checks

`scripts/verify-smoke.ts` runs these steps in order and stops at the first failure:

1. Build the web app with `vite build`.
2. Start `src/daemon/main.ts` with a temporary `AGENT_HUB_HOME`, a temporary `HOME`, and a random free port. The default vendor is the fake claude from `test/fake-claude/`. Other vendors point at paths that do not exist, so no real CLI starts and your own config stays untouched.
3. Open the passwordless login link and expect a 302 with a session cookie.
4. Call `GET /api/health` and `GET /api/state` with that cookie.
5. Open the workbench in headless Chromium and wait for the composer. Any `console.error` or `pageerror` fails the run.
6. Open Settings and press the wood beside the top-bar Router input (`scripts/verify-window-drag.ts`). The point must hit a `data-window-drag` region outside `data-no-drag`, a click and a double-click must reach a recorded `windowDrag` bridge as a drag and a zoom with Settings still open, and a click on the rail must then close Settings. With Settings open again, a click on the Router input must close Settings, leave the focus in the input, and never reach the bridge.
7. At every interface scale, close the work panel and resize the window (`scripts/verify-shell-widths.ts`). At the `860px` desktop minimum the PM column must keep its `13.75rem` minimum beside a conversation of at least `20rem`. At `700px` that must hold too, or the single-column shell must show. At `400px` and `375px` with a mouse, the single-column shell must show, a project must open from the list, and its composer must take typing. Back at `1280px`, the columns must return with the typed draft. The page must never scroll sideways.
8. Check Settings and New PM by keyboard, scale, and width (`scripts/verify-settings-keyboard.ts`). At the Compact and XL scales, at `1280px` and `390px`, Settings must not scroll sideways. At `860px` and `700px` in both scales, Settings must take the layout its width calls for (categories beside the sheet at `860px`, on top at `700px` Compact, the phone page at `700px` XL), and no category or phone page may scroll sideways. At the default scale, Tab from the General category through Settings, and through the New PM dialog with a valid name and More settings expanded, until focus cycles back to the first stop: focus must stay in the dialog, New PM must reach every control in order, and every stop must show a visible mark (a `2px` opaque outline, or on text fields an opaque field-focus ring with a `1px` spread).
9. Open the first Project Manager in the sidebar, send one message in the composer, wait for the fake Claude reply to render and the message to be stored as `replied`, then capture `workbench-smoke.png`.
10. Open the work panel, type in the composer, and click the `Info` tab (`scripts/verify-tab-focus.ts`). The pressed tab must not match `:focus-visible`, while `Shift+Tab` back to it and `ArrowLeft` to `Completed` must each draw the `2px` keyboard outline.
11. Stop the daemon the way the desktop shell does: `SIGTERM` on macOS and Linux, `POST /admin/shutdown` on Windows. The daemon must exit with code 0, and no child process it recorded in `state/child-processes.json` may still be alive.
12. Start a second daemon on the same `AGENT_HUB_HOME`, verify the conversation and both messages survived unchanged, and stop it cleanly.
13. Delete the temporary directory and check that it is gone.

## When to use it

- Before you push: run `pnpm typecheck`, `pnpm test:related`, and `pnpm verify`. After you push, Implementation Workers hand off right away so parallel review and cloud CI run together; wait for the PR's CI checks with `node scripts/wait-checks.ts <PR>` (or `node scripts/wait-checks.ts` on the PR branch) instead of `gh pr checks --watch` only when the PR touches platform code that this machine cannot test (Linux `bwrap`, Windows native, or desktop packaging), when `pnpm test:related` lists test files that the sandbox made skip, or when the PR has no immediately following review step, so pending `bellwood/review` does not hang and merge conflicts fail immediately (`docs/review-and-merge.md`, "Cloud checks and handoff").
- In an independent review: run it on the commit under review.
- Changes to the Linux `bwrap` sandbox, Windows native code, or packaging cannot be tested here. The matching cloud job on the PR is their only test.

If a run fails, read the error line in `smoke-runs.txt` first. It names the step and includes the daemon's stderr when the daemon exits early. Never rerun a failed cloud job with `gh run rerun` to hide a flaky test. Report the flake as a finding.

## Extend it

Add a check to `runOnce` in `scripts/verify-smoke.ts` only if it is fast and catches a failure that unit tests miss. Keep a full run under `VERIFY_SMOKE_BUDGET_MS` in `src/shared/limits.ts`.
