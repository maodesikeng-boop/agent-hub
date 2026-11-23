# Official relay release and operations

> Snapshot: 2026-11-23 (commit `4b1fb2e2`)

The public blind E2EE relay (`https://bellwood-relay.bellwood-mesh.workers.dev`, `MESH_DEFAULT_RELAY_URL` in [`src/shared/limits.ts`](../src/shared/limits.ts)) runs on Cloudflare Workers and SQLite-backed Durable Objects (`RelayAccountObject` in [`src/relay/cloudflare/worker.ts`](../src/relay/cloudflare/worker.ts)). Because all v0.3.0+ clients default to this endpoint, relay changes move through automated checks, an isolated staging Worker, and a manually approved production deployment.

## Environments

| Environment | Worker name | Origin | Wrangler command | Purpose |
| --- | --- | --- | --- | --- |
| Staging | `bellwood-relay-staging` | `https://bellwood-relay-staging.bellwood-mesh.workers.dev` | `pnpm exec wrangler deploy --env staging` | Automated post-merge deploy and live smoke verification |
| Production | `bellwood-relay` | `https://bellwood-relay.bellwood-mesh.workers.dev` | `pnpm exec wrangler deploy --env=""` | Default public relay served to Bellwood users |

Both environments share the same worker entrypoint and SQLite Durable Object class (`RelayAccountObject`), while Cloudflare isolates Durable Object storage per Worker name (`bellwood-relay-staging` vs `bellwood-relay`).

### Health contract (`GET /health`)

Both the Cloudflare Worker and the Node relay expose `GET /health` (and `HEAD /health`) with `Cache-Control: no-store`:

```json
{
  "ok": true,
  "service": "bellwood-relay",
  "protocolVersion": 1,
  "buildSha": "2fdc4a7b...",
  "versionId": "59af01cf-...",
  "deployedAt": "2026-11-23T01:45:00.000Z"
}
```

- `buildSha` comes from `BUILD_SHA` (injected by CI via `--var BUILD_SHA:$GITHUB_SHA`) or falls back to Cloudflare's `VERSION_METADATA.tag` (injected via `--tag`). Both values travel with the Cloudflare Worker Version snapshot so a rollback restores the rolled-back `buildSha`, `versionId`, and `deployedAt`.
- `protocolVersion` matches `RELAY_PROTOCOL_VERSION` in [`src/relay/protocol.ts`](../src/relay/protocol.ts).

## Pipeline (`.github/workflows/relay.yml`)

| Trigger | Jobs run | Side effects |
| --- | --- | --- |
| `pull_request` to `main` touching relay inputs | `check` (`pnpm typecheck`, `cloudflare` workerd tests, Node relay + smoke + workflow tests, `wrangler deploy --dry-run` for production & staging) | None; never deploys |
| `push` to `main` touching relay inputs | `check` -> `deploy-staging` | Deploys `[env.staging]` and runs `node scripts/relay-smoke.ts` with `--expect-sha` |
| `workflow_dispatch` (`target=check-only`) | `check` | None |
| `workflow_dispatch` (`target=deploy-staging`) | `check` -> `deploy-staging` | Deploys `[env.staging]` and runs live smoke check |
| `workflow_dispatch` (`target=deploy-production`, `main` only) | `check` -> `deploy-staging` -> `deploy-production` (pauses for `production` Environment approval) | Deploys production and runs live smoke check |
| `workflow_dispatch` (`target=rollback-production`, `main` only) | `check` -> `rollback-production` (pauses for `production` Environment approval) | Rolls back production Worker Version and runs live smoke check |

### What `scripts/relay-smoke.ts` verifies

1. Polls `GET /health` until HTTP `200`, `ok === true`, `service === "bellwood-relay"`, `protocolVersion === RELAY_PROTOCOL_VERSION`, and (when `--expect-sha` is set) `buildSha === expectSha`.
2. Checks `HEAD /health` returns `200`.
3. Checks `GET /v1/nope` returns `404` (`not_found`), plain HTTP `GET /v1/accounts/<id>/control` returns `426` (`upgrade_required`), and `POST /v1/register` with `{}` returns `400` (`bad_frame`).
4. Opens a real `wss://` control WebSocket to `RelayAccountObject`, waits for `challenge`, signs an Ed25519 `hello` frame, and verifies the Durable Object initializes SQLite storage and responds with `unknown_device` (`1008`).
5. Opens a `wss://` channel WebSocket and verifies the Durable Object rejects the unpaired session cleanly with `1008`.

## One-time Cloudflare and GitHub setup

1. **Cloudflare API token.** Create a token in Cloudflare Dashboard (`My Profile -> API Tokens -> Create Token -> Edit Cloudflare Workers` template) scoped to the account hosting `bellwood-mesh.workers.dev` with `Workers Scripts: Edit` and `Account Settings: Read`.
2. **Cloudflare Account ID.** Copy the Account ID from the Cloudflare Dashboard (`Workers & Pages -> Overview`, right sidebar).
3. **GitHub `staging` Environment.** Under `Settings -> Environments`, create `staging`. Add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Set Environment variable `RELAY_STAGING_URL` only if staging uses an origin other than `https://bellwood-relay-staging.bellwood-mesh.workers.dev`.
4. **GitHub `production` Environment.** Under `Settings -> Environments`, create `production`. Enable **Required reviewers** and add the repository maintainer, set **Deployment branches and tags** to **Selected branches -> `main`**, and add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
5. **External availability monitoring (recommended).** Configure an uptime monitor (Cloudflare Health Checks, UptimeRobot, or Better Stack) to poll `GET https://bellwood-relay.bellwood-mesh.workers.dev/health` every 1 to 5 minutes and alert when status is not `200` or `"ok":true` is absent.

## Production release runbook

1. Merge the relay change to `main` via pull request and wait for the `relay` workflow on `main` to finish green (`check` + `deploy-staging`).
2. Confirm staging health matches the `main` commit SHA:
   ```sh
   curl -fsS https://bellwood-relay-staging.bellwood-mesh.workers.dev/health
   ```
3. Before deploying protocol or Durable Object changes, verify backward compatibility with released clients (for example v0.3.0+ with `RELAY_PROTOCOL_VERSION = 1`) and existing `RelayAccountRecord` SQLite state in `normalizeRecord` (`src/relay/core.ts`).
4. Start the production release from GitHub Actions (`Actions -> relay -> Run workflow`, branch `main`, `target = deploy-production`), or via CLI:
   ```sh
   gh workflow run relay.yml --ref main -f target=deploy-production
   ```
5. Wait for `check` and `deploy-staging` to pass on that run, then approve the `production` deployment prompt in GitHub Actions.
6. Confirm `deploy-production` turns green and `GET https://bellwood-relay.bellwood-mesh.workers.dev/health` reports the expected `buildSha` and a new `versionId`.

## Rollback runbook

> [!CAUTION]
> `wrangler rollback` reverts Worker code, `[vars]`, and `VERSION_METADATA` across 100% of traffic, **but does not revert persisted Durable Object SQLite data or `[[migrations]]` schema changes**. Roll back only when the target older version remains compatible with current Durable Object SQLite records; breaking schema changes must roll forward.

### Option A: GitHub Actions (recommended, audited)

1. Identify the last good `versionId` or confirm rolling back to the immediate prior deployment from the previous `deploy-production` log (`Pre-deploy production state` step) or Cloudflare Dashboard (`Workers & Pages -> bellwood-relay -> Deployments`).
2. Run `Actions -> relay -> Run workflow` on branch `main` with `target = rollback-production`, optional `rollback_version_id` (leave blank for the previous stable version), and a brief `rollback_reason`.
3. Approve the `production` Environment prompt.
4. Confirm `rollback-production` finishes green and `scripts/relay-smoke.ts` passes against `https://bellwood-relay.bellwood-mesh.workers.dev`.

### Option B: Emergency Wrangler CLI (when GitHub Actions is unavailable)

1. Authenticate Wrangler locally (`pnpm exec wrangler login`, or export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`).
2. Inspect recent deployments and versions:
   ```sh
   pnpm exec wrangler deployments list --env=""
   pnpm exec wrangler versions list --env=""
   ```
3. Roll back to the previous stable version (or a specific `<version-id>`):
   ```sh
   pnpm exec wrangler rollback --env="" --yes --message "Incident rollback: <reason>"
   # Or target a specific version:
   pnpm exec wrangler rollback --env="" <version-id> --yes --message "Incident rollback: <reason>"
   ```
4. Verify production health and WebSocket Durable Object handshakes immediately:
   ```sh
   node scripts/relay-smoke.ts --url https://bellwood-relay.bellwood-mesh.workers.dev
   curl -fsS https://bellwood-relay.bellwood-mesh.workers.dev/health
   ```
5. Revert the faulty commit on `main` via pull request before triggering the next deployment.
