# Feishu integration

Bellwood connects to Feishu (and Lark) over an outbound persistent WebSocket (`WSClient`) so users can talk to Router in 1-on-1 chat, run each project inside a dedicated slime-avatar group chat, invite teammates with three-tier guest permissions, and answer decision cards from a phone with zero public IP, domain, or reverse proxy (`src/daemon/feishu/`, `src/feishu/`, and `src/shared/feishu.ts`).

## SDK boundary and setup

- **Single SDK import boundary**: Only `src/daemon/feishu/sdk.ts` imports `@larksuiteoapi/node-sdk`. Every other Feishu module depends on the typed `FeishuTransport` interface in `src/daemon/feishu/transport.ts` (enforced by `REVIEW.md`).
- **QR onboarding (`node src/feishu/main.ts connect` or `/api/feishu/*` on local loopback)**: Calls Feishu's official `registerApp` device flow to create a private bot, stores credentials in `state/feishu-secrets.json` (`0600`, blocked from all Workers by `DataDirReadScope`), binds the owner on first direct message or one-time bind code (`FEISHU_BIND_CODE_TTL_MS`), and checks required scopes via `src/daemon/feishu/scopes.ts`. Peer requests to `/api/feishu/*` return `forbidden_peer`.
- **Lazy memory footprint**: Daemons without Feishu configured do not load `@larksuiteoapi/node-sdk` (~40 MB saved), and `sharp` loads on demand only when rendering group avatars or shrinking oversized images (`> 2 MB` or `> 2400 px` edge).

## Direct Router chat and slime project groups

- **1-on-1 chat routes to Router**: Direct messages to the bot route to **Router**, mirroring pending `Needs You` cards, milestone reports, SAS device-approval cards, and `/settings` (or `/policy` and `/model`) model-picker cards.
- **Shared Router chat across mesh computers (`projection.ts`, `decision-cards.ts`, and `account-bot.ts`)**: `router_items`, gate asks, and blocker asks live only in the ledger of the computer whose PM raised them, so every computer binds the Router chat ID synced from the hub (skipping older router events) and posts its own briefings, decision, checkpoint, and blocker cards there over HTTPS, titled with the project name (`简报 · <PM>`). Only the lease holder greets the owner, posts device-approval and `/settings` cards, and handles inbound Router text. Card buttons carry the issuing computer as a compact `d: <deviceId>` field, so the hub forwards a Router chat tap to that computer over `/api/peer/feishu/inbound` or answers with the offline toast; cards without `d` stay local. Card, text, and file send UUIDs include the device ID, and file UUIDs also name the destination (`f` for a project group, `rf` for the Router chat), because Feishu dedupes UUIDs across the whole app and every ledger numbers its rows from 1.
- **Project groups (`src/daemon/feishu/chats.ts` and `avatars.ts`)**: Each non-archived PM automatically gets a private Feishu group named after the PM, with its pixel fruit slime (`look = fruit x color`, cached by content SHA-256 in `feishu_avatars`) rendered as the group avatar and a `fusa:<deviceId>:pm:<pmId>` marker in the group description so multi-computer accounts never confuse group ownership.

## Wake rules and three-tier guest permissions (`src/shared/feishu.ts`)

`feishuWakes` and `feishuGuestMay` centralize group routing and access control:

- **Solo vs team wake mode**: When only the owner is in a project group, every message wakes the PM directly. As soon as teammates join, the group automatically switches to `@bot` mention mode: unmentioned messages and media accumulate quietly in a bounded recent context buffer (`FEISHU_CONTEXT_MAX_LINES`, `FEISHU_CONTEXT_MAX_CHARS`, `FEISHU_CONTEXT_MAX_FILES`, `2h` TTL) and prepend with speaker attribution when someone `@`-mentions the bot.
- **Guest tiers (set per group via `/settings`, `/policy`, or `/api/feishu/chats/:pmId/policy`)**:

| Tier | Capabilities |
| --- | --- |
| `observer` | Read-only in group; messages stay in passive context when the owner starts a turn and never wake the PM. |
| `chat_only` (default) | Can `@`-mention the bot to start PM turns; card buttons, `Stop`, and file uploads stay owner-only. |
| `collaborator` | Can `@`-mention the bot, answer decision cards, click `Stop`, and upload attachments. |

- **Owner-only ledger lock (`FEISHU_GUEST_BLOCKED_HUB_COMMANDS`)**: Even during a turn triggered by a `chat_only` or `collaborator` guest, `hubCall` in `src/daemon/ledger/hub-commands.ts` hard-blocks system-mutating commands (creating projects, attaching or detaching workspace folders, editing setup scripts, or editing PM personas).

## Streaming JSON 2.0 cards, decisions, and media

- **Live streaming with `Stop` (`src/daemon/feishu/stream.ts` and `cards.ts`)**: Replies stream through Feishu CardKit JSON 2.0 `streaming_mode` (`300 ms` flush interval, global `FEISHU_CARDKIT_BUDGET_PER_SECOND` rate budget split across active mesh devices, automatic renewal at `9m` before Feishu's `10m` stream timeout, and clean multi-card splitting past `FEISHU_CARD_MAX_CHARS`) with an inline **Stop** button that interrupts the turn within Feishu's `2.5s` callback deadline. A status-only card is recalled when its turn ends with no reply text, such as after a stop or a tool-only turn. When a project manager turn fails, the card instead closes on the reason from the failed user message (`failureReason` through `describeFailure`), or a separate card carries it when no card is open, once per turn.
- **Bidirectional card sync**: Answering a decision card on desktop updates the Feishu card in place, and tapping an option in Feishu settles the card on desktop and wakes downstream Task Graph steps.
- **Concurrent media pre-upload (`src/daemon/feishu/files.ts`)**: Deliverables upload outside the serial card queue via `p-limit` (`FEISHU_UPLOAD_CONCURRENCY = 3`, waiting up to `FEISHU_ATTACH_WAIT_MS = 2.5s` before posting text with `Uploading` placeholders that patch in once ready).

## Watchdog, reconnect catch-up, and mesh failover

- **Connection watchdog**: `sdk.ts` enables `wsConfig.pingTimeout` (`FEISHU_WS_PING_TIMEOUT_S`) and `handshakeTimeoutMs` so half-open NAT or VPN drops are detected promptly.
- **Inbound catch-up (`feishu_inbound_cursors`)**: On startup and every reconnect (coalesced by generation counter), the daemon reads `GET im/v1/messages` oldest first from each active chat's cursor, bounded by `FEISHU_INBOUND_CATCHUP_WINDOW_MS` (`15m`, plus `30s` overlap), deduplicates against `seenInboundMessages` (LRU) and ledger `client:<conv>:feishu:<message_id>` keys, replays missed messages in chronological order before live events, and advances the cursor **only** after each message finishes processing (checking `signal.aborted` after every `await` on shutdown). One round takes at most `FEISHU_INBOUND_CATCHUP_MAX_MESSAGES` (the inbound queue capacity) unseen messages per chat. A longer backlog takes the queue-full path: it holds the cursor before the first message left out, logs it, and sets `lastError`, so the next reconnect resumes from there.
- **Offline past the window**: When a chat's cursor is older than the window, the daemon probes the uncovered span newest first (up to `FEISHU_INBOUND_GAP_PROBE_MAX_PAGES` pages). If the span holds an unseen owner message, an `@bot` mention, or any Router 1-on-1 message, or is too busy to scan in full, the bot posts one text in that chat asking the owner to resend anything still unanswered and logs the gap. The cursor then moves to the window start, so the same gap never triggers a second reminder.
- **Outbound catch-up and mesh offline inbox**: Reconnects, and every switch from lease holder to HTTP-only sender (including a holder whose WSClient never came up), patch cards settled while offline, replay up to `FEISHU_CATCHUP_MAX_MESSAGES` missed replies per chat, resume incomplete uploads, and drain `feishu_offline_inbox` when a sleeping mesh computer comes back online ([Account mesh and E2EE relay](account-mesh-design.md)).
