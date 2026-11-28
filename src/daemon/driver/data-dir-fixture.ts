import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { writeExecutableFileAtomicSync } from "../platform/index.ts";

export interface SandboxDataDir {
  dataDir: string;
  stateDir: string;
  own: string;
  launchDir: string;
  hubSock: string;
  adminSock: string;
  env: Record<string, string>;
  createLate(): void;
  close(): Promise<void>;
}

export const DENIED_PROBES: readonly (readonly [string, string])[] = [
  ["state/ui-token", "UI_TOKEN_READ"],
  ["state/provider-secrets.json", "PROVIDER_SECRETS_READ"],
  ["state/feishu-secrets.json", "FEISHU_SECRETS_READ"],
  ["state/mesh/key.pem", "MESH_KEY_READ"],
  ["state/push-vapid.json", "PUSH_VAPID_READ"],
  ["state/push-subscriptions.json", "PUSH_SUBS_READ"],
  ["state/hub.sqlite", "DB_READ"],
  ["state/hub.sqlite.bak-1", "DB_BACKUP_READ"],
  ["state/peers.json", "PEERS_READ"],
  ["state/tunnel.json", "TUNNEL_READ"],
  ["state/pm-memory/1/MEMORY.md", "PM_MEMORY_READ"],
  ["state/personas/pm-1.md", "PERSONA_READ"],
  ["state/router-home/note.md", "ROUTER_HOME_READ"],
  ["state/logs/daemon.log", "LOGS_READ"],
  ["state/launch/8/prompt.md", "OTHER_LAUNCH_READ"],
  ["backups/sync/settings.json.bak", "BACKUP_READ"],
  ["pm-home/notes.md", "PM_HOME_READ"],
  ["pm-notes/legacy.md", "LEGACY_TOP_READ"],
  ["sent-files/0123456789abcdef/f.txt", "SENT_FILES_READ"],
];

export const LATE_DENIED_PROBES: readonly (readonly [string, string])[] = [
  ["state/provider-secrets-late.json", "LATE_STATE_READ"],
  ["backups/late/settings.json.bak", "LATE_BACKUP_READ"],
  ["late-top/secret.txt", "LATE_TOP_READ"],
];

export const ALLOWED_PROBES: readonly (readonly [string, string])[] = [
  ["state/launch/7/prompt.md", "LAUNCH_READ"],
  ["uploads/u.txt", "UPLOAD_READ"],
  ["tools/npm/t.txt", "TOOLS_READ"],
  ["worktrees/1/3/other.txt", "OTHER_WT_READ"],
];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

/** Keep the root short because macOS limits Unix socket paths to 103 bytes. */
export async function makeSandboxDataDir(root: string): Promise<SandboxDataDir> {
  const dataDir = join(root, "home");
  const stateDir = join(dataDir, "state");
  const own = join(dataDir, "worktrees", "1", "2");
  const launchDir = join(stateDir, "launch", "7");
  mkdirSync(own, { recursive: true });
  for (const [rel] of [...DENIED_PROBES, ...ALLOWED_PROBES]) write(join(dataDir, rel), `${rel}\n`);
  const hub = join(dataDir, "run", "bin", "hub");
  mkdirSync(dirname(hub), { recursive: true });
  writeExecutableFileAtomicSync(hub, "#!/bin/sh\necho HUB_RAN\n", { mode: 0o755 });
  const hubSock = join(dataDir, "run", "hub.sock");
  const adminSock = join(dataDir, "run", "admin.sock");
  const servers = [await listen(hubSock), await listen(adminSock)];
  return {
    dataDir,
    stateDir,
    own,
    launchDir,
    hubSock,
    adminSock,
    env: { D: dataDir, L: launchDir, O: own, N: process.execPath },
    createLate: () => {
      for (const [rel] of LATE_DENIED_PROBES) write(join(dataDir, rel), `${rel}\n`);
    },
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    },
  };
}

export function readProbeScript(): string {
  const connect = [
    'const net = require("node:net");',
    'const targets = [["HUB_CONNECTED", process.env.D + "/run/hub.sock"], ["ADMIN_CONNECTED", process.env.D + "/run/admin.sock"]];',
    "let left = targets.length;",
    "for (const [mark, path] of targets) {",
    "  const s = net.connect(path);",
    '  s.on("connect", () => { console.log(mark); s.destroy(); if (--left === 0) process.exit(0); });',
    '  s.on("error", () => { if (--left === 0) process.exit(0); });',
    "}",
  ].join(" ");
  return [
    ...[...DENIED_PROBES, ...LATE_DENIED_PROBES, ...ALLOWED_PROBES].map(([rel, mark]) => `cat "$D/${rel}" >/dev/null 2>&1 && echo ${mark}`),
    'ls -a "$D/state" 2>/dev/null | grep -qx ui-token && echo STATE_LISTED',
    'ls -a "$D" 2>/dev/null | grep -qx backups && echo DATA_DIR_LISTED',
    'cd "$O" && test "$(pwd -P)" = "$O" && echo CWD_OK',
    '"$D/run/bin/hub" 2>/dev/null',
    `"$N" -e '${connect}'`,
  ].join("; ");
}

export function writeProbeCli(dir: string): string {
  const cli = join(dir, "probe-cli");
  writeExecutableFileAtomicSync(cli, `#!/bin/sh\n${readProbeScript()}\n`, { mode: 0o755 });
  return cli;
}

export const EXPECTED_PROBE_OUTPUT: readonly string[] = [
  ...ALLOWED_PROBES.map(([, mark]) => mark),
  "CWD_OK",
  "HUB_RAN",
  "HUB_CONNECTED",
];
