# Contributing to Bellwood

Thanks for helping. This guide covers how to report a problem, set up a checkout, and get a pull request merged. `AGENTS.md` holds the full engineering rules; this file is the short version for human contributors.

## Report a problem

- **Security issue:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Bug:** open a bug report. Include the Bellwood version, OS, install method, and the agent CLI involved. Attach the tail of `~/.agent-hub/state/logs/daemon.log` after you remove tokens, keys, and chat content.
- **Feature idea:** open a feature request and describe the problem before the solution.

## Set up

Requires Node.js 24.12 or later, pnpm 10, and git.

```sh
pnpm install --frozen-lockfile
pnpm start    # builds dist/web and starts the daemon on 127.0.0.1:4317
```

## Before you push

Run these four commands. All four must pass.

```sh
pnpm lint
pnpm typecheck
pnpm test:related   # every test affected by your branch, not only the tests next to the files you changed
pnpm verify         # real daemon plus headless Chromium smoke check
```

`pnpm test:related` compares your branch with `origin/main`, so run `git fetch origin main` first. Do not run the whole suite locally unless `pnpm test:related` decides to. Linux `bwrap` sandbox and Windows tests only run in the cloud, so their PR checks are their tests.

## Pull requests

- Branch from `main` and keep each PR to one change.
- Title the PR in Conventional Commits form, for example `fix(daemon): close the socket on shutdown`.
- Fill in the PR template. Write the description, commit messages, code comments, and docs in English.
- Open a design or plan PR that still waits for a decision as a draft. Mark it ready after the decision.
- Wait for every CI check on the PR to finish green (`node scripts/wait-checks.ts <PR>`, which skips pending `bellwood/review` on paths awaiting independent review and fails immediately on merge conflicts). A red check blocks the merge, even when it looks unrelated. Never rerun a failed job to hide a flaky test; report the flake instead.
- Changes that touch a `Trigger:` path in `REVIEW.md` need an independent review before merge.
- Maintainers merge with squash merge. Direct pushes to `main` are blocked.

## Project layout

See the "Directory layout" section of `AGENTS.md`, the full testing, review, and merge rules in [docs/review-and-merge.md](docs/review-and-merge.md), and the documentation index in [docs/README.md](docs/README.md).
