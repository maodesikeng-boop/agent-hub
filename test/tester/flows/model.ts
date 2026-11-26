// Runners for real vendor CLI flows. A vendor's quota or login failure is reported as vendorTrouble, never as a failed check.
import { spawnSync } from "node:child_process";
import { API_PATHS, VENDOR_LIST, vendorFailureOf, workerEventOf, type AgentVendor, type Message, type ProvidersStatusResponse, type ResourcesSnapshot } from "../../../src/shared/index.ts";
import type { InstanceClient } from "../bench.ts";
import { messagesAfter } from "../instance-client.ts";
import { benchCliPath } from "../local-instance.ts";
import type { FlowContext, FlowRunner } from "../types.ts";
import { ensureBenchPm, runner, runTag, vendorPm, waitFor, workerPm, type Observation } from "./common.ts";

const TURN_REPLY_MS = 120_000;
const TURN_WAIT_MS = 170_000;
const WORKER_REPORT_MS = 10 * 60_000;
const SETTLED = new Set(["replied", "failed", "stopped", "cancelled"]);

function clientOf(ctx: FlowContext): InstanceClient {
  return ctx.instance === "local" ? ctx.bench.local() : ctx.bench.remote();
}

async function saveLog(ctx: FlowContext, obs: Observation): Promise<void> {
  const logs = ctx.instance === "local" ? ctx.bench.local().logs : ctx.bench.remote().logs;
  obs.save("daemon.log", logs ? await logs(200).catch((e: unknown) => `logs unavailable: ${String(e)}\n`) : "the bench has no remote control\n");
}

async function noLeftover(client: InstanceClient, conversationId: number, signal: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  await client.api.request("POST", API_PATHS.stop(conversationId));
  await waitFor(
    async () => {
      const state = await client.state();
      const session = state.sessions.find((s) => s.conversationId === conversationId && s.status !== "ended");
      return session?.activity === "stopping" ? undefined : true;
    },
    10_000,
    signal,
    250,
  );
  const snapshot = await client.api.json<ResourcesSnapshot>("GET", `${API_PATHS.resources}?refresh=1`);
  const held = snapshot.held.filter((h) => h.kind === "process");
  const ok = snapshot.processes.leakedCount === 0 && held.length === 0;
  return { ok, detail: `${snapshot.processes.trackedCount} tracked, ${snapshot.processes.leakedCount} leaked, ${held.length} held processes` };
}

/** Postcondition: a runner that sends one message to the bench PM bound to `vendor` on ctx.instance and checks the reply and leftovers. */
function vendorTurn(vendor: AgentVendor): FlowRunner {
  return runner(async (ctx, obs) => {
    const client = clientOf(ctx);
    const pm = await ensureBenchPm(client, vendorPm(vendor, ctx.instance));
    const t0 = Date.now();
    const sent = await client.send(pm.conversationId, `Bench turn ${runTag()}: reply with the single word pong.`);
    const settled = await waitFor(async () => (await messagesAfter(client.api, pm.conversationId, sent - 1)).find((m) => m.id === sent && SETTLED.has(m.status ?? "")), TURN_WAIT_MS, ctx.signal, 2_000);
    const after = await messagesAfter(client.api, pm.conversationId, sent - 1);
    obs.json("state.json", after);
    const reply = after.find((m: Message) => m.id > sent && m.sender === "agent" && m.kind === "text" && m.text.trim() !== "");
    obs.metrics.replyMs = settled?.status === "replied" ? (reply?.createdAt ?? Date.now()) - t0 : -1;
    const failure = settled?.status === "failed" ? vendorFailureOf(settled.failureReason ?? "", vendor) : null;
    if (failure?.kind === "quota" || failure?.kind === "auth") obs.vendorTrouble = { vendor, kind: failure.kind, detail: settled!.failureReason ?? "" };
    const ok = settled?.status === "replied" && reply !== undefined && obs.metrics.replyMs <= TURN_REPLY_MS;
    obs.check("reply-arrives", ok, settled === null ? `message ${sent} still ${after.find((m) => m.id === sent)?.status} after ${TURN_WAIT_MS / 1000} s` : `message ${settled.status}${settled.failureReason ? `: ${settled.failureReason}` : ""}; reply after ${obs.metrics.replyMs} ms`);
    const leftover = await noLeftover(client, pm.conversationId, ctx.signal);
    obs.check("no-leftover", leftover.ok, leftover.detail);
    await saveLog(ctx, obs);
  });
}

/** Parses `cli <vendor> <installed|missing> [version]` lines from the remote forced command's status output. */
export function remoteCliProbe(status: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const m of status.matchAll(/^cli (\S+) (installed|missing)\b/gm)) out.set(m[1]!, m[2] === "installed");
  return out;
}

const providerStatus = runner(async (ctx, obs) => {
  const client = clientOf(ctx);
  const providers = await client.api.json<ProvidersStatusResponse>("GET", `${API_PATHS.providers}?refresh=1`);
  obs.json("catalog.json", providers);
  const listed = new Set(providers.providers.map((p) => p.vendor));
  const missing = VENDOR_LIST.filter(({ id }) => !listed.has(id)).map(({ id }) => id);
  obs.check("every-vendor-listed", missing.length === 0, missing.length === 0 ? `all ${VENDOR_LIST.length} vendors listed` : `missing: ${missing.join(", ")}`);
  let probe: Map<string, boolean> | null = null;
  if (ctx.instance === "local") {
    const instance = ctx.bench.local().config;
    probe = new Map(VENDOR_LIST.map(({ id }) => [id, benchCliPath(id, instance, providers.platform as NodeJS.Platform) !== null]));
  } else {
    const status = ctx.bench.remote().status;
    if (status) probe = remoteCliProbe(await status());
  }
  const rows = providers.providers.map((p) => ({ vendor: p.vendor, daemonInstalled: p.installed, availability: p.availability, version: p.version, probeInstalled: probe?.get(p.vendor) ?? null }));
  obs.json("coverage.json", rows);
  const mismatched = rows.filter((r) => r.probeInstalled !== null && r.probeInstalled !== r.daemonInstalled);
  const unprobed = probe === null ? "no independent probe on this computer (no remote control)" : "";
  obs.check("status-matches", probe !== null && mismatched.length === 0, unprobed || (mismatched.length === 0 ? "the daemon agrees with the bench probe for every vendor" : mismatched.map((r) => `${r.vendor}: daemon ${r.daemonInstalled ? "installed" : "missing"}, probe ${r.probeInstalled ? "installed" : "missing"}`).join("; ")));
});

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

const workerRoundTrip = runner(async (ctx, obs) => {
  const local = ctx.bench.local();
  const sandbox = ctx.bench.config.sandboxProject;
  const base = git(sandbox, ["rev-parse", "HEAD"]);
  const pm = await ensureBenchPm(local, workerPm(sandbox));
  const tag = runTag();
  const sent = await local.send(pm.conversationId, `Bench worker check ${tag}: start one Worker on the cheapest model to append the line "bench ${tag}" to BENCH.md and commit only that file. Report back when it is done.`);
  const report = await waitFor(async () => (await messagesAfter(local.api, pm.conversationId, sent)).find((m) => workerEventOf(m)?.event === "report"), WORKER_REPORT_MS, ctx.signal, 5_000);
  obs.json("state.json", await messagesAfter(local.api, pm.conversationId, sent - 1));
  const meta = report === null ? null : workerEventOf(report);
  obs.check("worker-reported", meta !== null, meta === null ? `no Worker report within ${WORKER_REPORT_MS / 60_000} min` : `Worker ${meta.workerId} reported: ${meta.summary ?? meta.status}`);
  const branch = meta === null ? "" : git(sandbox, ["for-each-ref", "--format=%(refname:short)", `refs/heads/hub/${meta.workerId}-*`]).split("\n")[0] ?? "";
  if (branch === "") {
    obs.check("commit-made", false, meta === null ? "no Worker" : `no branch hub/${meta.workerId}-* in ${sandbox}`);
    return;
  }
  const commits = git(sandbox, ["rev-list", `${base}..${branch}`]).split("\n").filter(Boolean);
  const files = git(sandbox, ["diff", "--name-only", base, branch]).split("\n").filter(Boolean);
  obs.save("worker-diff.patch", `${git(sandbox, ["diff", base, branch])}\n`);
  obs.check("commit-made", commits.length === 1 && files.length === 1 && files[0] === "BENCH.md", `${commits.length} commits on ${branch}, files: ${files.join(", ") || "none"}`);
});

export const modelRunners: Readonly<Record<string, FlowRunner>> = {
  ...Object.fromEntries(VENDOR_LIST.map(({ id }) => [`model.turn.${id}`, vendorTurn(id)])),
  "model.provider-status": providerStatus,
  "model.worker-round-trip": workerRoundTrip,
};
