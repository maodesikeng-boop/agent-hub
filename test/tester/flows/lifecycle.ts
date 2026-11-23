// Runners for restart and upgrade flows on the bench's long-lived data directory.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { API_PATHS, ENV_HOME, ENV_MESH_PORT, ENV_PORT, ENV_RELAY_URL, type AccountStatusView, type StateSnapshot } from "../../../src/shared/index.ts";
import type { RemoteInstanceConfig } from "../bench.ts";
import { benchLayout, localDaemonEnv, spawnDaemon, stopDaemon } from "../local-instance.ts";
import type { FlowContext, FlowRunner } from "../types.ts";
import { runner, waitFor } from "./common.ts";

const PEER_BACK_MS = 30_000;
/** A loopback port nothing listens on, so a copied data directory never reaches the relay with the bench's identity. */
const DEAD_RELAY = "http://127.0.0.1:9";

interface ConversationDigest {
  id: number;
  lastMessageId: number | null;
}

export function conversationDigest(state: StateSnapshot): ConversationDigest[] {
  return state.conversations
    .map((c) => ({ id: c.conversation.id, lastMessageId: c.messages.reduce<number | null>((max, m) => (max === null || m.id > max ? m.id : max), null) }))
    .sort((a, b) => a.id - b.id);
}

/** Postcondition: one line per conversation in `before` that is missing in `after` or whose last message changed. */
export function digestLoss(before: readonly ConversationDigest[], after: readonly ConversationDigest[]): string[] {
  const now = new Map(after.map((c) => [c.id, c.lastMessageId]));
  return before.flatMap((c) => (!now.has(c.id) ? [`conversation ${c.id} is missing`] : now.get(c.id) !== c.lastMessageId ? [`conversation ${c.id} last message ${c.lastMessageId} -> ${now.get(c.id)}`] : []));
}

const restartKeepsData = runner(async (ctx, obs) => {
  const local = ctx.bench.local();
  const remoteId = ctx.bench.config.instances.find((i): i is RemoteInstanceConfig => i.role === "remote")!.deviceId;
  const before = conversationDigest(await local.state());
  obs.json("before.json", before);
  await local.restart(local.mode ?? "fake");
  const after = conversationDigest(await local.state());
  obs.json("after.json", after);
  const lost = digestLoss(before, after);
  obs.check("conversations-kept", lost.length === 0, lost.length === 0 ? `${before.length} conversations unchanged` : lost.join("; "));
  const restarted = Date.now();
  const trusted = await waitFor(
    async () => {
      const view = await local.api.json<AccountStatusView>("GET", API_PATHS.account);
      if (view.state !== "signed_in" || !view.devices.some((d) => d.id === remoteId)) return undefined;
      return (await ctx.bench.remote().health()).ok ? true : undefined;
    },
    PEER_BACK_MS,
    ctx.signal,
  );
  obs.check("peer-trusted", trusted !== null, trusted === null ? `the remote computer was not trusted and reachable within ${PEER_BACK_MS / 1000} s` : `reachable ${Date.now() - restarted} ms after the restart`);
});

function run(cwd: string, command: string, args: string[]): string {
  const res = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${command} ${args.join(" ")} in ${cwd} exited ${res.status}: ${res.stderr.trim().slice(-500)}`);
  return res.stdout.trim();
}

/** The newest formal release tag behind the code under test; release candidate tags are skipped. */
export function previousReleaseTag(codeDir: string): string {
  return run(codeDir, "git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "--exclude", "*-*", "HEAD^"]);
}

const migrationCount = (codeDir: string) => readdirSync(join(codeDir, "migrations")).filter((f) => f.endsWith(".sql")).length;
const backups = (dataDir: string) => (existsSync(join(dataDir, "state")) ? readdirSync(join(dataDir, "state")).filter((f) => f.startsWith("hub.sqlite.bak-")) : []);

/** A copy of the local data directory that cannot reach the relay or Feishu, so it never competes with the bench for its identity. */
function isolatedCopy(ctx: FlowContext, dir: string): string {
  const local = ctx.bench.local().config;
  rmSync(dir, { recursive: true, force: true });
  cpSync(local.dataDir, dir, { recursive: true });
  rmSync(join(dir, "state", "feishu-secrets.json"), { force: true });
  rmSync(join(dir, "state", "lock"), { force: true });
  return dir;
}

async function bootOnce(ctx: FlowContext, codeDir: string, dataDir: string, logFile: string): Promise<StateSnapshot> {
  const local = ctx.bench.local().config;
  const env = { ...localDaemonEnv({ config: ctx.bench.config, instance: local, codeDir, mode: "fake", platform: process.platform, baseEnv: process.env }), [ENV_HOME]: dataDir, [ENV_PORT]: "0", [ENV_MESH_PORT]: "0", [ENV_RELAY_URL]: DEAD_RELAY };
  const daemon = await spawnDaemon(codeDir, env, logFile);
  try {
    return await daemon.api.json<StateSnapshot>("GET", API_PATHS.state);
  } finally {
    await stopDaemon(daemon);
  }
}

const upgradeFromRelease = runner(async (ctx, obs) => {
  const local = ctx.bench.local();
  const codeDir = local.codeDir;
  const tag = previousReleaseTag(codeDir);
  const layout = benchLayout(ctx.bench.config.root);
  const releaseDir = join(layout.localDir, "release", tag);
  if (!existsSync(join(releaseDir, "package.json"))) {
    rmSync(releaseDir, { recursive: true, force: true });
    run(codeDir, "git", ["worktree", "prune"]);
    mkdirSync(join(layout.localDir, "release"), { recursive: true });
    run(codeDir, "git", ["worktree", "add", "--detach", releaseDir, tag]);
  }
  if (!existsSync(join(releaseDir, "node_modules"))) {
    run(releaseDir, "pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--reporter=silent"]);
  }
  const mode = local.mode ?? "fake";
  await local.stop();
  const logFile = join(ctx.evidenceDir, "upgrade.log");
  try {
    const copy = isolatedCopy(ctx, join(layout.localDir, "upgrade-home"));
    const before = conversationDigest(await bootOnce(ctx, releaseDir, copy, logFile));
    obs.json("before.json", before);
    const backupsBefore = new Set(backups(copy));
    const after = conversationDigest(await bootOnce(ctx, codeDir, copy, logFile));
    obs.json("after.json", after);
    const fresh = backups(copy).filter((f) => !backupsBefore.has(f));
    const migrated = migrationCount(codeDir) > migrationCount(releaseDir);
    obs.check("backup-written", !migrated || fresh.length > 0, migrated ? (fresh.length > 0 ? `backup ${fresh.join(", ")}` : "migrations ran but no hub.sqlite.bak-* appeared") : `no new migration since ${tag}; no backup expected`);
    const missing = before.filter((c) => !after.some((a) => a.id === c.id));
    obs.check("data-opens", missing.length === 0, missing.length === 0 ? `${before.length} conversations from ${tag} load` : `missing after upgrade: ${missing.map((c) => c.id).join(", ")}`);
    if (!existsSync(logFile)) obs.save("upgrade.log", "");
    else if (!obs.evidence.includes("upgrade.log")) obs.evidence.push("upgrade.log");
  } finally {
    await local.start(mode);
  }
});

export const lifecycleRunners: Readonly<Record<string, FlowRunner>> = {
  "lifecycle.restart-keeps-data": restartKeepsData,
  "lifecycle.upgrade-from-release": upgradeFromRelease,
};
