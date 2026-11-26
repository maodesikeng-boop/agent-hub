// The flow catalog: every user flow the tester checks, as data. The handbook and `cli.ts list` read it from here.
// Invariant: every flow without `manual` has exactly one runner in RUNNERS, and every runner reports each `pass` check of its flow.
import { feishuRunners } from "./flows/feishu.ts";
import { lifecycleRunners } from "./flows/lifecycle.ts";
import { meshRunners } from "./flows/mesh.ts";
import { modelRunners } from "./flows/model.ts";
import { TESTER_DEFAULT_CONSECUTIVE_FAILURES, TESTER_RATE_MIN_PASSES, TESTER_RATE_WINDOW } from "./limits.ts";
import { VENDOR_LIST } from "../../src/vendors/registry.ts";
import type { Cadence, FlowRunner, FlowSpec } from "./types.ts";

const FEISHU_PATHS = ["src/daemon/feishu/**", "src/shared/feishu.ts", "src/feishu/**"];
const MESH_PATHS = ["src/daemon/mesh/**", "src/daemon/peers/**", "src/relay/**", "src/mesh/**"];
const DRIVER_PATHS = ["src/daemon/driver/**", "src/vendors/_common/**"];
const LEDGER_PATHS = ["migrations/**", "src/daemon/store/**", "src/daemon/daemon.ts", "src/daemon/main.ts"];

const consecutive = { kind: "consecutive", failures: TESTER_DEFAULT_CONSECUTIVE_FAILURES } as const;
const rate = { kind: "rate", window: TESTER_RATE_WINDOW, minPasses: TESTER_RATE_MIN_PASSES } as const;
const noRecall = { check: "no-recall", rule: "No message the test bot sent during the flow is deleted or shows as recalled." } as const;
const oneDevice = { feishu: "real", network: "relay", model: "real", devices: 1 } as const;
const twoDevicesFake = { feishu: "real", network: "relay", model: "fake", devices: 2 } as const;
const feishuNeeds = ["remote_instance", "feishu_bot", "feishu_driver"] as const;

/**
 * One real-CLI turn flow per vendor in VENDOR_LIST, run on each bench computer, so a new vendor is covered the day it is registered.
 * A vendor whose VENDOR_BENCH entry is an accepted gap still gets its flow; the flow reports not_ready with the owner's reason.
 */
function vendorTurnFlows(): FlowSpec[] {
  return VENDOR_LIST.map(({ id, label }) => ({
    id: `model.turn.${id}`,
    area: "model",
    title: `A PM turn on the real ${label} CLI`,
    story: `The owner sends a PM that uses ${label} a short message and the real CLI answers with the bench's cheapest model for it. On the remote computer the message goes through the mesh proxy.`,
    boundaries: { feishu: "none", network: "loopback", model: "real", devices: 1 },
    needs: [`vendor:${id}`],
    cadences: ["nightly", "rc", "pr"],
    triggers: [`src/vendors/${id}/**`, ...DRIVER_PATHS],
    pass: [
      { check: "reply-arrives", rule: "The PM replies within 120 s and the user message ends as replied." },
      { check: "no-leftover", rule: "After the PM is stopped no child process it started is alive." },
    ],
    evidence: ["state.json", "daemon.log"],
    tolerance: consecutive,
    timeoutMs: 180_000,
    escapes: [],
    perInstance: true,
  }));
}

export const FLOWS: readonly FlowSpec[] = [
  {
    id: "feishu.dm-router",
    area: "feishu",
    title: "Router answers a direct message",
    story: "The owner sends the bot a direct message in Feishu and Router replies in the same chat.",
    boundaries: oneDevice,
    needs: [...feishuNeeds],
    cadences: ["nightly", "rc", "pr"],
    triggers: FEISHU_PATHS,
    pass: [
      { check: "reply-arrives", rule: "A test bot message follows the owner's message within 90 s." },
      { check: "reply-final", rule: "The reply card is no longer streaming and has non-empty text." },
      noRecall,
    ],
    evidence: ["messages.json", "timings.txt"],
    tolerance: consecutive,
    timeoutMs: 120_000,
    escapes: [],
  },
  {
    id: "feishu.group-round-trip",
    area: "feishu",
    title: "A project group on the second computer replies",
    story: "The owner posts in the project group of a PM that lives on the local computer while the remote computer holds the Feishu connection. The PM's streaming card ends with its reply.",
    boundaries: twoDevicesFake,
    needs: ["local_instance", ...feishuNeeds],
    cadences: ["nightly", "rc", "pr"],
    triggers: [...FEISHU_PATHS, ...MESH_PATHS],
    pass: [
      { check: "not-offline", rule: "The hub forwards the message; no offline notice appears in the group." },
      { check: "reply-arrives", rule: "The PM's card appears within 30 s of the owner's message." },
      { check: "reply-text", rule: "The final card text equals the scripted reply." },
      noRecall,
    ],
    evidence: ["messages.json", "timings.txt", "local-daemon.log", "remote-daemon.log"],
    tolerance: rate,
    timeoutMs: 90_000,
    escapes: ["#409", "#415"],
  },
  {
    id: "feishu.failed-turn-card",
    area: "feishu",
    title: "A failed turn explains itself in the card",
    story: "The PM's model run fails. The owner sees the reason in the group instead of a recalled message.",
    boundaries: twoDevicesFake,
    needs: ["local_instance", ...feishuNeeds],
    cadences: ["nightly", "rc", "pr"],
    triggers: FEISHU_PATHS,
    pass: [
      { check: "reason-shown", rule: "A test bot card carries the failure reason within 30 s." },
      noRecall,
    ],
    evidence: ["messages.json", "local-daemon.log"],
    tolerance: consecutive,
    timeoutMs: 90_000,
    escapes: ["#411"],
  },
  {
    id: "feishu.offline-inbox-replay",
    area: "feishu",
    title: "A message to a sleeping computer is answered when it wakes",
    story: "The local computer goes offline. The owner posts in its project group, gets an offline notice, and receives the PM's reply after the computer comes back.",
    boundaries: twoDevicesFake,
    needs: ["local_instance", ...feishuNeeds],
    cadences: ["nightly", "rc", "pr"],
    triggers: [...FEISHU_PATHS, ...MESH_PATHS],
    pass: [
      { check: "offline-notice", rule: "The hub posts one offline notice in the group within 30 s." },
      { check: "replayed", rule: "The PM replies within 60 s after the local computer is back online." },
      { check: "single-reply", rule: "The message is answered exactly once." },
      noRecall,
    ],
    evidence: ["messages.json", "timings.txt", "local-daemon.log", "remote-daemon.log"],
    tolerance: rate,
    timeoutMs: 240_000,
    escapes: ["#411"],
  },
  {
    id: "feishu.reconnect-catch-up",
    area: "feishu",
    title: "A message sent during a restart is not lost",
    story: "The computer that holds the Feishu connection restarts while the owner sends a direct message. Router answers it once after the restart.",
    boundaries: oneDevice,
    needs: ["remote_control", ...feishuNeeds],
    cadences: ["nightly", "rc", "pr"],
    triggers: FEISHU_PATHS,
    pass: [
      { check: "answered-once", rule: "Router answers the message sent during the restart exactly once within 120 s of the restart." },
      noRecall,
    ],
    evidence: ["messages.json", "remote-daemon.log"],
    tolerance: consecutive,
    timeoutMs: 240_000,
    escapes: [],
  },
  {
    id: "feishu.hub-failover",
    area: "feishu",
    title: "The second computer takes over the Feishu connection",
    story: "The computer first in Hub order stops. The next one takes the Feishu connection and answers the owner, then hands it back when the first returns.",
    boundaries: { feishu: "real", network: "relay", model: "fake", devices: 2 },
    needs: ["local_instance", "remote_control", ...feishuNeeds],
    cadences: ["rc", "pr"],
    triggers: [...FEISHU_PATHS, ...MESH_PATHS],
    pass: [
      { check: "lease-moved", rule: "The local computer holds the Feishu lease within 60 s of the remote stopping." },
      { check: "dm-answered", rule: "A direct message sent after the move is answered." },
      { check: "lease-returned", rule: "The lease returns to the remote within 60 s of its restart." },
    ],
    evidence: ["leases.txt", "messages.json", "local-daemon.log", "remote-daemon.log"],
    tolerance: consecutive,
    timeoutMs: 300_000,
    escapes: [],
  },
  {
    id: "feishu.desktop-answer-syncs-card",
    area: "feishu",
    title: "Answering on the desktop settles the Feishu card",
    story: "A PM asks the owner a question. The card appears in Feishu; the owner answers in the workbench and the Feishu card updates in place.",
    boundaries: twoDevicesFake,
    needs: ["local_instance", ...feishuNeeds],
    cadences: ["nightly", "rc", "pr"],
    triggers: FEISHU_PATHS,
    pass: [
      { check: "card-posted", rule: "A decision card appears in the PM's group within 30 s." },
      { check: "card-settled", rule: "Within 15 s of the desktop answer the same message is updated and shows the chosen option." },
      noRecall,
    ],
    evidence: ["messages.json", "card-before.json", "card-after.json"],
    tolerance: consecutive,
    timeoutMs: 120_000,
    escapes: [],
  },
  {
    id: "feishu.tap-card-on-phone",
    area: "feishu",
    title: "Tapping a card option on the phone",
    story: "The owner taps an option on a decision card in the Feishu phone app. The workbench settles the question and the next Task Graph step wakes.",
    boundaries: oneDevice,
    needs: [...feishuNeeds],
    cadences: ["rc"],
    triggers: [],
    pass: [{ check: "settled", rule: "The workbench shows the question answered within 5 s and the card shows the chosen option." }],
    evidence: ["phone-screenshot.png"],
    tolerance: consecutive,
    timeoutMs: 300_000,
    escapes: [],
    manual: true,
  },
  {
    id: "feishu.stop-on-phone",
    area: "feishu",
    title: "Stop from the phone",
    story: "The owner taps Stop on a streaming reply in the Feishu phone app.",
    boundaries: oneDevice,
    needs: [...feishuNeeds],
    cadences: ["rc"],
    triggers: [],
    pass: [{ check: "stopped", rule: "The reply stops within 3 s and the card says it was stopped." }],
    evidence: ["phone-screenshot.png"],
    tolerance: consecutive,
    timeoutMs: 300_000,
    escapes: [],
    manual: true,
  },
  {
    id: "mesh.cold-dial",
    area: "mesh",
    title: "The local computer reaches the remote one over the relay",
    story: "After the link has been idle, the owner opens the other computer in the workbench and its data loads.",
    boundaries: { feishu: "none", network: "relay", model: "fake", devices: 2 },
    needs: ["local_instance", "remote_instance"],
    cadences: ["nightly", "rc", "pr"],
    triggers: MESH_PATHS,
    pass: [
      { check: "dials-succeed", rule: "At least 9 of 10 cold dials through the relay return HTTP 200." },
      { check: "dial-latency", rule: "The 90th percentile cold dial takes under 6 s." },
    ],
    evidence: ["dials.txt"],
    tolerance: rate,
    timeoutMs: 300_000,
    escapes: ["#409", "#415"],
  },
  {
    id: "mesh.router-sees-online",
    area: "mesh",
    title: "Router sees the second computer as online",
    story: "The local computer starts. The remote computer's Router lists it as online and keeps doing so while it idles.",
    boundaries: { feishu: "none", network: "relay", model: "fake", devices: 2 },
    needs: ["local_instance", "remote_instance", "remote_control"],
    cadences: ["nightly", "rc", "pr"],
    triggers: MESH_PATHS,
    pass: [
      { check: "online-within", rule: "The remote reports the local computer online within 15 s of its start." },
      { check: "no-flap", rule: "It never reports it offline during 120 s of idling." },
    ],
    evidence: ["presence.txt"],
    tolerance: rate,
    timeoutMs: 180_000,
    escapes: ["#409", "#415"],
  },
  {
    id: "mesh.cross-device-chat",
    area: "mesh",
    title: "Chat with a PM on the other computer",
    story: "From the local workbench the owner sends a message to a PM on the remote computer and watches the reply arrive live.",
    boundaries: { feishu: "none", network: "relay", model: "real", devices: 2 },
    needs: ["local_instance", "remote_instance", "vendor:claude"],
    vendorInstance: "remote",
    cadences: ["nightly", "rc", "pr"],
    triggers: MESH_PATHS,
    pass: [
      { check: "reply-arrives", rule: "The remote PM's reply appears in the local workbench within 120 s." },
      { check: "live-update", rule: "The reply arrives over the state stream before a full reload would show it." },
    ],
    evidence: ["state-stream.jsonl", "timings.txt"],
    tolerance: rate,
    timeoutMs: 180_000,
    escapes: [],
  },
  {
    id: "model.provider-status",
    area: "model",
    title: "Settings shows each vendor's real state",
    story: "The owner opens Settings and sees, for every supported vendor, whether it is installed and signed in, so no vendor quietly disappears from the workbench.",
    boundaries: { feishu: "none", network: "loopback", model: "real", devices: 1 },
    needs: [],
    cadences: ["nightly", "rc", "pr"],
    triggers: ["src/vendors/**", "src/daemon/driver/model-catalog.ts", "src/shared/paths.ts"],
    pass: [
      { check: "every-vendor-listed", rule: "The daemon's catalog lists every vendor in VENDOR_LIST." },
      { check: "status-matches", rule: "Each vendor's reported availability matches the bench's own probe of that CLI." },
    ],
    evidence: ["catalog.json", "coverage.json"],
    tolerance: consecutive,
    timeoutMs: 60_000,
    escapes: [],
    perInstance: true,
  },
  ...vendorTurnFlows(),
  {
    id: "model.worker-round-trip",
    area: "model",
    title: "A PM dispatches a Worker that edits and reports",
    story: "The owner asks a PM for a one-line change in the sandbox project. A real Worker edits its worktree, commits, and reports back.",
    boundaries: { feishu: "none", network: "loopback", model: "real", devices: 1 },
    needs: ["local_instance", "vendor:claude"],
    cadences: ["rc"],
    triggers: [...DRIVER_PATHS, "src/daemon/ledger/workers/**"],
    pass: [
      { check: "worker-reported", rule: "A Worker report reaches the PM within 10 min." },
      { check: "commit-made", rule: "The Worker's branch has one new commit that touches only the requested file." },
    ],
    evidence: ["state.json", "worker-diff.patch"],
    tolerance: consecutive,
    timeoutMs: 900_000,
    escapes: [],
  },
  {
    id: "lifecycle.restart-keeps-data",
    area: "lifecycle",
    title: "A restart keeps months of real data",
    story: "The local computer restarts on its long-lived data directory. Conversations, the Feishu binding, and the trusted peer are all still there.",
    boundaries: { feishu: "real", network: "relay", model: "fake", devices: 2 },
    needs: ["local_instance", "remote_instance"],
    cadences: ["nightly", "rc", "pr"],
    triggers: LEDGER_PATHS,
    pass: [
      { check: "conversations-kept", rule: "Every conversation and its last message id match before and after." },
      { check: "peer-trusted", rule: "The remote computer is still trusted and reachable within 30 s." },
    ],
    evidence: ["before.json", "after.json"],
    tolerance: consecutive,
    timeoutMs: 120_000,
    escapes: [],
  },
  {
    id: "lifecycle.upgrade-from-release",
    area: "lifecycle",
    title: "Upgrade from the last formal release keeps data",
    story: "A copy of the bench's local data directory runs the previous formal release, then the candidate. The migration backup appears and the data opens.",
    boundaries: { feishu: "none", network: "loopback", model: "fake", devices: 1 },
    needs: ["local_instance"],
    cadences: ["rc"],
    triggers: LEDGER_PATHS,
    pass: [
      { check: "backup-written", rule: "A hub.sqlite.bak-<schema>-<time> file appears when migrations ran." },
      { check: "data-opens", rule: "Every conversation from before the upgrade loads." },
    ],
    evidence: ["before.json", "after.json", "upgrade.log"],
    tolerance: consecutive,
    timeoutMs: 300_000,
    escapes: [],
  },
];

export const RUNNERS: Readonly<Record<string, FlowRunner>> = { ...feishuRunners, ...meshRunners, ...modelRunners, ...lifecycleRunners };

/** Postcondition: true when `path` matches `glob`, where `**` spans directories and `*` stays within one. */
export function matchesGlob(path: string, glob: string): boolean {
  const pattern = glob
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => (part === "**/" ? "(?:.*/)?" : part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${pattern}$`).test(path.split("\\").join("/"));
}

/**
 * Postcondition: flows in catalog order that list `cadence`, narrowed to `ids` when given,
 * and for `pr` runs to flows whose triggers match at least one of `changedPaths`.
 * Throws when `ids` names a flow that is not in the catalog.
 */
export function selectFlows(catalog: readonly FlowSpec[], options: { cadence: Cadence; ids?: readonly string[]; changedPaths?: readonly string[] }): FlowSpec[] {
  const unknown = (options.ids ?? []).filter((id) => !catalog.some((f) => f.id === id));
  if (unknown.length > 0) throw new Error(`unknown flow: ${unknown.join(", ")}; run \`node test/tester/cli.ts list\``);
  const ids = options.ids === undefined || options.ids.length === 0 ? null : new Set(options.ids);
  return catalog.filter((flow) => {
    if (!flow.cadences.includes(options.cadence)) return false;
    if (ids !== null) return ids.has(flow.id);
    if (options.cadence !== "pr") return true;
    return (options.changedPaths ?? []).some((path) => flow.triggers.some((glob) => matchesGlob(path, glob)));
  });
}
