// Runners for resident restart and isolated release upgrades.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { API_PATHS, ENV_RELAY_URL, type AccountStatusView, type StateSnapshot } from "../../../src/shared/index.ts";
import { createInstanceClient } from "../instance-client.ts";
import type { InstanceClient, RemoteInstanceConfig } from "../bench.ts";
import { benchLayout, localDaemonEnv, spawnDaemon, stopDaemon } from "../local-instance.ts";
import type { FlowContext, FlowRunner } from "../types.ts";
import { ensureBenchPm, runner, scenarioPm, waitFor } from "./common.ts";
import { remoteIsReachable } from "./mesh.ts";

const SEED_WAIT_MS = 30_000;
const PEER_BACK_MS = 30_000;
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
      return remoteIsReachable(() => ctx.bench.remote().health());
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

async function bootOnce<T>(
  ctx: FlowContext, codeDir: string, root: string, run: (client: InstanceClient) => Promise<T>,
): Promise<T> {
  const userHome = join(root, "user");
  const dataDir = join(root, "data");
  mkdirSync(userHome, { recursive: true });
  const config = { ...ctx.bench.config, root };
  const instance = { ...ctx.bench.local().config, dataDir, userHome, uiPort: 0, meshPort: 0, env: {} };
  const env = { ...localDaemonEnv({ config, instance, codeDir, mode: "fake", platform: process.platform, baseEnv: process.env }), [ENV_RELAY_URL]: DEAD_RELAY };
  const daemon = await spawnDaemon(codeDir, env, join(ctx.evidenceDir, "upgrade.log"));
  try {
    return await run(createInstanceClient("upgrade fixture", daemon.api));
  } finally {
    await stopDaemon(daemon);
  }
}

async function seedRelease(client: InstanceClient, signal: AbortSignal): Promise<ConversationDigest[]> {
  const pm = await ensureBenchPm(client, scenarioPm("echo"));
  const sent = await client.send(pm.conversationId, "Save this message before the upgrade.");
  await client.waitForReply(pm.conversationId, sent, SEED_WAIT_MS, signal);
  const before = conversationDigest(await client.state());
  if (!before.some(({ id, lastMessageId }) => id === pm.conversationId && lastMessageId !== null && lastMessageId > sent)) {
    throw new Error("the release did not persist the seeded conversation and reply");
  }
  return before;
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
  const root = mkdtempSync(join(layout.localDir, "upgrade-"));
  const dataDir = join(root, "data");
  obs.evidence.push("upgrade.log");
  try {
    const before = await bootOnce(ctx, releaseDir, root, (client) => seedRelease(client, ctx.signal));
    obs.json("before.json", before);
    const backupsBefore = new Set(backups(dataDir));
    ctx.signal.throwIfAborted();
    const after = await bootOnce(ctx, codeDir, root, async (client) => conversationDigest(await client.state()));
    obs.json("after.json", after);
    const fresh = backups(dataDir).filter((f) => !backupsBefore.has(f));
    const migrated = migrationCount(codeDir) > migrationCount(releaseDir);
    obs.check("backup-written", !migrated || fresh.length > 0, migrated ? (fresh.length > 0 ? `backup ${fresh.join(", ")}` : "new migrations but no hub.sqlite.bak-* backup") : `no new migration since ${tag}; no backup expected`);
    const lost = digestLoss(before, after);
    obs.check("data-opens", lost.length === 0, lost.length === 0 ? `${before.length} conversations from ${tag} load with their last messages` : lost.join("; "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

export const lifecycleRunners: Readonly<Record<string, FlowRunner>> = {
  "lifecycle.restart-keeps-data": restartKeepsData,
  "lifecycle.upgrade-from-release": upgradeFromRelease,
};
