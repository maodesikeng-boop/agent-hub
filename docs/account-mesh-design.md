# Account mesh and E2EE relay

Bellwood links a user's macOS, Windows, and Linux computers into a private peer-to-peer mesh without public IPs, SSH tunnels, port forwarding, or third-party VPN clients (`src/daemon/mesh/`, `src/daemon/peers/`, `src/mesh/`, and `src/relay/`). Phones interact with every linked computer through a single account-wide Feishu bot ([Feishu integration](feishu-design.md)).

## Identity, GitHub login, and six-digit SAS trust

- **Local device identity (`src/daemon/mesh/identity.ts`)**: Each daemon keeps a stable UUID in `state/device.json`. On first account login, it generates an Ed25519 private key (`state/mesh/key.pem`, mode `0600`, unreadable to all Workers) and a self-signed X.509 certificate (`state/mesh/cert.pem`, `CN = <deviceId>`) via `@peculiar/x509`. A device's cryptographic fingerprint is the SHA-256 digest of its certificate DER.
- **Passwordless GitHub Device Flow (`Computers` in **Settings**, or `node src/mesh/main.ts login`)**:
  1. The daemon requests a GitHub device code using a public OAuth App `client_id` (no client secret required) with empty scope (public profile only).
  2. After the user authorizes in a browser, the daemon sends `POST /v1/register` to the relay with the GitHub token, its certificate PEM, device ID, name, and platform.
  3. The relay verifies `GET https://api.github.com/user`, derives `acct_<base32(sha256("github:" + numericUserId))>`, registers the first device as `active` and subsequent devices as `pending`, and discards the GitHub token immediately (caching only a short-lived SHA-256 token digest in `src/relay/guards.ts` to avoid hammering GitHub). The daemon likewise discards the GitHub token and writes only `state/account.json` (`0600`).
  4. All subsequent relay connections authenticate by signing a server nonce with `state/mesh/key.pem`.
- **Six-digit SAS verification (`state/peers.json` v2)**:
  - Neither GitHub nor the relay can silently inject a trusted computer. A `pending` computer can exchange only bounded `signal` frames (`<= 4 KB`) with `active` computers.
  - When the user clicks **Verify** on an existing trusted computer `A`, `A` and the new computer `N` run a commit-then-reveal nonce exchange over the relay and independently compute a six-digit decimal Short Authentication String (`SHA-256(fingerprintA || fingerprintN || nonceA || nonceN)`).
  - The relay forwards `signal` frames without buffering and drops any frame whose target has no control connection, such as a new computer that reports `awaiting_approval` before its relay connection is up. Whenever either side sees the other come online, and whenever the user clicks **Verify** again during the same ceremony, it resends the ceremony messages the peer may still be missing (`ApprovalCeremony.outstanding()`). A side that receives an exact duplicate of a message it already accepted replays its earlier reply instead of aborting, so retries never restart a ceremony. A different message for the same step still aborts it. Each side handles one ceremony's messages one at a time in arrival order, so a resent `reveal` and `confirm` that arrive together cannot overtake each other, and a ceremony aborted while its SAS is being computed stays aborted.
  - Only after the user confirms **Match** on **both** devices does `A` add `N` to `state/peers.json` v2, broadcast an Ed25519-signed trust statement to other peers, push the full trust table to `N` over mutual TLS, and promote `N` to `active` on the relay.
  - Clicking **Remove computer...** on any trusted peer broadcasts a signed revocation statement and deletes the device on the relay; revoked certificates fail TLS handshakes on both LAN and relay paths.

## Transport: LAN direct first, blind E2EE relay fallback

- **Mutual TLS 1.3 everywhere (`ALPN: fusa-mesh/1`)**: Every daemon listens on `MESH_LISTEN_PORT` (`4320` by default, IPv4 and IPv6) requiring client certificates. After the TLS 1.3 handshake, both sides verify that the peer's certificate SHA-256 fingerprint is pinned in `state/peers.json` v2 and matches `CN`. Unauthenticated LAN scanners cannot complete a handshake.
- **LAN candidate exchange and SSRF guard**: Connected devices publish up to 8 private IPv4 and IPv6 ULA socket addresses to same-account peers via the relay (`isAllowedDirectHost` rejects loopback, link-local without scope, and cloud metadata IPs).
- **Happy-eyeballs dial (`dial(deviceId)`)**:
  1. Attempts direct LAN TCP + TLS 1.3 first with a `250 ms` head start (skipping direct dial for `60 s` after a failure).
  2. In parallel after `250 ms`, opens a relay binary WebSocket channel (`/v1/accounts/<acct>/channels/<128-bit-id>`, max `64 KB` per frame) where the relay blindly pipes raw TLS 1.3 ciphertext between `A` and `N` without terminating TLS. Whichever path finishes the mutual TLS handshake first wins; the other closes.
  3. The whole dial gets `MESH_DIAL_TIMEOUT_MS` (`10 s`). Each side opens its own relay channel, and on a slow link the dialer's channel can reach the relay seconds after the acceptor's, so the acceptor keeps its side open for the same budget. When an unpaired dial closes, the relay sends `dial.failed` right away so the dialer does not wait out its budget.
- **HTTP/1.1 and WebSocket multiplexing**: Verified TLS streams feed directly into Fastify's `meshEntry` server via a pooled `http.Agent`. Existing `/d/<deviceId>/api/*` proxying, WebSocket state streams, Router cross-device dispatch, and `/api/peer/*` RPCs run unchanged over the encrypted tunnel, while `meshEntry` blocks multi-hop `/d/` forwarding and local-only admin endpoints (`ENTRY_ONLY_API_PREFIXES`).

## Relay architecture and rate-limit hardening (`src/relay/`)

One runtime-agnostic core (`src/relay/core.ts`, `auth.ts`, `guards.ts`, and `protocol.ts`, built solely on standard Web APIs) powers two deployment shells:

1. **Cloudflare Workers + SQLite Durable Objects (`src/relay/cloudflare/worker.ts`, `wrangler.toml`)**: Routes each account to its own single-threaded Durable Object using the WebSocket Hibernation API so idle connections incur zero duration billing.
2. **Self-hosted Node relay (`src/relay/node/server.ts`)**: Runs the identical `core.ts` state machine behind `ws` for private deployments. Bellwood defaults to the official public blind relay (`MESH_DEFAULT_RELAY_URL`) and public GitHub Device Flow client ID (`MESH_GITHUB_CLIENT_ID`) in `src/shared/limits.ts`; `FUSA_RELAY_URL` and `FUSA_GITHUB_CLIENT_ID` override both.

Ingress rate limiting in `src/relay/guards.ts` trusts only `CF-Connecting-IP` on Cloudflare (never spoofable `X-Forwarded-For`), caps state size in `src/shared/limits.ts`, and separates one-shot probation keys from active multi-hit counters so a flood of random source IPs cannot evict counters for ongoing brute-force clients.

## Account-wide Feishu hub lease

Users order their computers under **Hub order** in **Settings** (`Computers` tab). The account's Durable Object grants the single `feishu` lease to the highest-priority online computer:

- Only the lease holder opens Feishu's outbound `WSClient` persistent connection, greets the owner in Router 1-on-1 chat, and handles its inbound text.
- Every computer sends its own project groups' streaming cards and media, plus its own Router briefings and decision cards in the shared 1-on-1 chat, directly to Feishu over HTTPS (splitting the `FEISHU_CARDKIT_BUDGET_PER_SECOND` rate budget across online computers).
- Inbound events for a project group owned by another online computer (`fusa:<deviceId>:pm:<pmId>`) forward over mutual TLS to `/api/peer/feishu/inbound`. If the owning computer is asleep, the hub replies immediately in the group and queues the message in `feishu_offline_inbox` (`24h` TTL) for ordered replay when that computer reconnects. A forward that fails while the owner still counts as online queues the message the same way and retries after `FEISHU_CONTROL_RETRY_MS`, and later messages for that computer wait behind queued ones so none overtakes another; if the hub itself goes offline, the next computer in **Hub order** automatically acquires the lease and takes over `WSClient`.
