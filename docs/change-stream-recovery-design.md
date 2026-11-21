# Event stream recovery across daemon restarts

## For the user

### Files to review

- [Recovery design](change-stream-recovery-design.md) covers the reconnect protocol and how it works across mixed versions.
- [Shared cursor contract](../src/shared/change-stream.ts) defines the cursor in both the snapshot and the WebSocket request.
- [Browser connection contract](../src/web/connection.ts) defines which socket and buffered changes can accompany a replacement snapshot.
- [Protocol cases](../src/shared/change-stream.test.ts), [server cases](../src/daemon/ui-server/server.test.ts), and [Mesh cases](../src/daemon/peers/proxy.test.ts) specify replay and resync behavior at each boundary.
- [Browser transport cases](../src/web/connection.test.ts), [device recovery cases](../src/web/device-hub.test.ts), and [real daemon restart cases](../test/e2e/change-stream-restart.test.ts) specify the recovery and fault injection tests.

### Decisions needed

None.

## User goal

> 都按照你的推荐来

The user approved the audit recommendation to fix both P1 findings through separate design, implementation, and review steps. For this finding, a browser that reconnects after its target daemon restarts must recover changes made while it was disconnected, including when the old sequence is inside the new daemon's replay window.

## Current state

- **[Measured]** I ran `node /tmp/bellwood-audit-906.SsKYbI/daemon-repro.mjs overlap` at the repository root. The script started two real daemons with the same temporary database and moved the second process's clock back 20 ms. The old cursor was `1760000000021`, the missed PM was present by `1759999999983`, and the second daemon reached `1760000000022`. The old cursor received one later event, no PM creation, and no `resync`. The second daemon's own cursor replayed the creation, and its full snapshot contained the PM. The process homes, database, and fake CLI state were under a throwaway directory.
- **[Inferred]** The ledger starts its sequence from the wall clock and checks only the numeric range and replay window. The WebSocket route asks the ledger to replay a numeric `since`. The snapshot already exposes the UI server's random startup UUID as `bootId`. See `src/daemon/ledger/context.ts:109`, `src/daemon/ledger/change-log.ts:26`, `src/daemon/ui-server/routes-ws.ts:24`, `src/daemon/ui-server/context.ts:59`, and `src/daemon/ui-server/routes-session.ts:141`.
- **[Inferred]** Local and remote browsers use the same `DeviceHub`, `openChangeStream`, and client URL builder. The remote hub keeps its own number and has no page reload callback. The local hub checks `/api/auth/status` on reconnect for its page reload callback. Both use one resync buffer without identifying the socket that supplied the frames. See `src/web/device-hub.ts:66`, `src/web/device-hub.ts:140`, `src/web/device-hub.ts:165`, `src/web/device-hub.ts:199`, `src/web/device-hub.ts:453`, `src/web/device-hub.ts:554`, `src/web/connection.ts:109`, and `src/web/client.ts:343`.
- **[Inferred]** The Mesh entry routes `/d/:id/api/ws` to the target with the original query. The proxy forwards application messages and closes the browser socket when its upstream socket closes. It also forwards the target's `/api/state` response. The entry's boot ID is independent of the target's. See `src/daemon/peers/routes.ts:187`, `src/daemon/peers/proxy.ts:36`, `src/daemon/peers/proxy.ts:135`, and `src/daemon/peers/proxy.ts:182`.

## Approach comparison

| Approach | Recovery | Cost |
| --- | --- | --- |
| Send a boot ID and sequence as one resume value over the existing WebSocket | Replay retained events from the same boot. Fetch a full snapshot when the boot or replay window changes. | Adds a shared query contract and binds each recovery request to its socket. A legacy target falls back to full resync. |
| Fetch a full snapshot on every reconnect | Rebuild from the target's current state on every connection. | Adds a snapshot request to every network interruption and still needs to pair the snapshot with the right socket. |
| Persist a global sequence and replay history in SQLite | Resume from a stored position across daemon restarts. | Adds durable event storage, transactional writes, and retention. It must also account for ephemeral stream events. |

Use the compound resume value. It keeps replay for short disconnects, takes the authoritative snapshot after a restart, and reuses the startup ID already shared by desktop status and browser snapshots.

### Wire contract

- `GET /api/state` supplies `bootId` and `seq`. The boot ID is the target UI server's lowercase UUID v4. The ledger counts from zero in production and increments once per change. `seq` is a non-negative safe integer with meaning only within its boot.
- Encode the resume cursor as one `since=<bootId>:<seq>` query value. The encoder supplies the leading `?`, and `URLSearchParams` handles escaping. Accept a canonical decimal sequence, including `0`, without leading zeroes.
- With no `since`, the WebSocket subscribes to live changes only. This supports existing live listeners such as presence tests. An explicitly empty, duplicate, numeric-only, malformed, unsafe, or foreign-boot value yields `{ "type": "resync" }` before any live change. Only pass a matched cursor's sequence to `ledger.changesSince`.
- Within a boot, replay in sequence order after the cursor. The latest sequence returns no backlog. A cursor ahead of the stream or more than one below the oldest retained sequence yields `resync`. Keep subscription and replay synchronous so a change arrives either in replay or as a live frame. Mesh peers continue to receive the same filtered projection of both.
- Keep the `resync` and change frame shapes. An old browser sending a number to a new daemon gets a full resync on each connection. A new browser sending the compound value to an old daemon gets the old server's immediate `resync`, because the old parser rejects the compound value as nonnumeric. Both versions then receive live changes. The browser rules below handle recovery for a new browser. A browser and target that both run the old protocol retain the original behavior.

### Browser recovery

1. Each `DeviceHub` stores the cursor of its applied state. Accept a snapshot only with a valid cursor and route an invalid response through the existing load or resync error path. Read the latest cursor on every socket attempt. Keep the requested cursor on the attempt for its entire lifetime.
2. Start a full `/api/state` fetch on `resync` from that device, and buffer subsequent changes from that socket while the request runs. Coalesce resync requests for the same attempt. Combine the socket's abort signal with the API timeout. When the socket retires, discard its buffer, stop its retry, and ignore any late response. A new attempt uses the last committed cursor. Apply the same recovery rules to snapshot refreshes while a stream is active, including manual reload and an unknown conversation. If a refresh has no active socket, connect from the fresh snapshot.
3. If the snapshot shares the requested boot and the buffer is intact, replace state and apply only buffered changes above the snapshot cursor in wire order. The requested boot comes from state observed before the socket opened. The snapshot fetch starts after subscription for a server `resync`. A unique boot ID observed on both sides of opening that socket establishes the boot even when a legacy target sends untagged frames. Preserve gaps in sequence numbers because peers do not receive entry-only router changes.
4. If the snapshot boot differs or the buffer overflowed, install the new snapshot and replace the socket. The new attempt carries the snapshot's cursor and replays later changes or receives another `resync`. If a legacy target restarted, expect one additional full fetch after replacing the socket. The second fetch can keep the socket once both cursor and snapshot agree on the new boot. This also handles a restart between the snapshot request and the upstream Mesh upgrade.
5. Keep local page reload and draft retention driven by the boot ID of the applied local snapshot. Remote hubs recover in place. The recovery path still invokes the local resync callback for device list updates.

### Migration by boundary

| Boundary | Implementation work |
| --- | --- |
| Ledger and `/api/ws` | In `ledger/context.ts` and `ledger/ledger.ts`, use a boot-local production start and keep explicit starts for fixtures. In `ledger/change-log.ts`, check the numeric bounds within one boot. In `ui-server/routes-ws.ts`, resolve `since` against `UiCtx.instanceId` before consulting the ledger. |
| Snapshot and desktop status | Keep `routes-session.ts` as the source of the HTTP boot ID. Keep desktop health and auth status compatible with the macOS and Windows supervisors. |
| Browser | In `client.ts`, use the same encoder for local and device-prefixed URLs. In `connection.ts`, type URL and reconnect callbacks with `ChangeCursor`, pass a `ChangeStreamConnection` with each frame, and retire its signal on close, replacement, or disposal. In `device-hub.ts`, scope cursor and recovery per device. Keep `auto-reload.ts` on the applied local snapshot callback. |
| Mesh entry and relay | `peers/routes.ts` and `peers/proxy.ts` already forward the query, target snapshot, and application frames. Preserve that behavior over both LAN and relay. The relay transport, Feishu WebSockets, heartbeat tests, and live-only push presence subscribers do not need a resume cursor. |
| In-repo clients and fixtures | Update `test/e2e/harness.ts` and its `daemon.test.ts` and `m2.test.ts` callers. Update `test/e2e/account-mesh.test.ts` to take the cursor from the remote snapshot. Update numeric WebSocket fixtures in `ui-server/server.test.ts`, `peers/proxy.test.ts`, and `web/{connection,client,auto-reload,App,devices}.test.*` plus `web/test-utils.ts`. Leave the deliberate numeric legacy cases in the protocol tests. |

## Performance and bounds

1. The daemon loses the replay window when it restarts. A socket retirement invalidates its recovery state, and removing a device disposes its hub and cursor.
2. Keep the existing `CHANGE_BUFFER_SIZE` of 1,000 for daemon replay. Reuse it as the per-device cap for changes waiting on a browser snapshot. When the next change would exceed the cap, drop the buffer and recover from the next snapshot cursor. Each cursor has one UUID and one number. A month of 300 finished workers, 30,000 messages, and 50,000 step logs does not increase the number of retained frames. The existing snapshot endpoint still uses its pagination and compression rules.
3. Keep cursor and recovery metadata private to `DeviceHub`. Transport status and applied data remain the inputs to the existing Zustand selectors. Stable selectors and views keep the same references when their inputs do not change.
4. Before review, compare same-boot replay and overflow recovery on the base and implementation commits using the existing smoke and replay paths. Record frame counts, snapshot request counts, and time to usable state for an isolated 1,000-change backlog and a backlog above the cap. Compare at least five alternating runs for timing claims. Record correctness and the measured range in the PR using the repository benchmark checklist and blast radius review.

The existing replay cap bounds both buffers, so this plan needs no new `src/shared/limits.ts` constants. The cursor adds a bounded WebSocket query value.

## Cross-vendor and cross-platform unification

`src/shared/change-stream.ts` defines the same cursor for all vendors registered in `src/shared/vendors.ts`. Vendor events enter the shared ledger before reaching the stream. The TypeScript daemon and browser use this contract on macOS, Windows, and Linux under `src/daemon/platform/index.ts`. A future vendor implements its normal driver adapter. It needs no cursor code.

## Deletions

- Remove the wall clock seed and its monotonicity assumption. Keep a fixed `initialSeq` override where fixtures need a specific replay range.
- Remove numeric-only replay from `routes-ws.ts`, numeric reconnect URLs and handlers in the browser and test harness, and the browser's resync buffer shared across socket attempts.
- Remove the browser's reconnect-time `fetchBootId` request. A changed boot triggers full snapshot recovery, and the applied local snapshot continues to drive page reload.

## Skeleton files

| File | Responsibility |
| --- | --- |
| [`docs/README.md`](README.md) | Lists the recovery design in the architecture index. |
| [`docs/change-stream-recovery-design.md`](change-stream-recovery-design.md) | Records the protocol, migration, and evidence expected before review. |
| [`src/shared/change-stream.ts`](../src/shared/change-stream.ts) | Defines the cursor and the shared snapshot, encoding, and request contracts. |
| [`src/web/connection.ts`](../src/web/connection.ts) | Defines a socket attempt and the result of reconciling a snapshot with its buffer. |
| [`src/shared/change-stream.test.ts`](../src/shared/change-stream.test.ts) | Specifies cursor parsing, validation, and boot matching. |
| [`src/web/connection.test.ts`](../src/web/connection.test.ts) | Specifies socket lifetime and the recovery decision for buffered frames. |
| [`src/web/device-hub.test.ts`](../src/web/device-hub.test.ts) | Specifies local and remote recovery, race handling, and legacy target behavior. |
| [`src/daemon/ui-server/server.test.ts`](../src/daemon/ui-server/server.test.ts) | Specifies the response to valid, stale, legacy, and out-of-window cursors. |
| [`src/daemon/peers/proxy.test.ts`](../src/daemon/peers/proxy.test.ts) | Specifies forwarding for both a new target and a legacy target. |
| [`test/e2e/change-stream-restart.test.ts`](../test/e2e/change-stream-restart.test.ts) | Specifies the isolated two-daemon fault injection. |

## Verification plan

1. Convert the TODO cases into assertions and run them against the existing behavior. Use the same sequence in three requests. The new daemon must replay with its own boot ID and require resync with the previous boot ID or a number alone. The old daemon replays the number alone and rejects both compound cursors. The three requests distinguish boot validation from blanket rejection.
2. In `test/e2e/change-stream-restart.test.ts`, use the existing harness and restart over the same temporary database. Obtain the first boot's cursor, disconnect, stop the process, and start the second daemon. Create the missed PM before the reconnect. Emit enough changes to put the first sequence inside the second boot's retained range. Assert the old cursor receives `resync` first with no replay. Fetch the full snapshot, assert it contains the missed PM, reconnect with its cursor, and assert later changes arrive once. Run a same-boot control and assert a different injected clock leaves the production sequence independent of time. Capture the old and new boot IDs, replay bounds, first frame, and snapshot assertion.
3. In `src/daemon/peers/proxy.test.ts`, compare the target and entry boot IDs and show that the entry preserves the query and target's `resync`. Include a legacy target that replies with `resync` to a compound value. In `src/web/device-hub.test.ts`, drive the remote device to a lower or equal new sequence, return a changed snapshot, and assert the missed state appears. Delay a fetch across a second reconnect and assert only the latest attempt can apply a snapshot and buffered frames.
4. Run `pnpm typecheck` and the targeted files with `pnpm exec vitest run`. Include `src/code-hygiene.test.ts`, `src/shared/change-stream.test.ts`, `src/daemon/ledger/ledger.test.ts`, `src/daemon/ui-server/{server,auth-status}.test.ts`, `src/daemon/peers/{proxy,push-boundary}.test.ts`, `src/web/{connection,client,device-hub,auto-reload}.test.ts`, `src/web/{App,devices}.test.tsx`, and `test/e2e/{change-stream-restart,daemon,m2,account-mesh}.test.ts`. Check the service worker API exclusions with `src/web/pwa.test.ts`.
5. Run `pnpm verify` and inspect the workbench screenshot. Use temporary user and daemon homes for the reproduction, tests, and smoke check.
