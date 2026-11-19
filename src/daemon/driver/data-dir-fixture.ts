// 数据目录读边界的真沙箱测试共用（write-scope.test.ts 的 macOS sandbox-exec、write-scope.linux.test.ts 的 bwrap）：
// 造一个像真的数据目录（令牌、密钥、库、记忆、日志、备份、遗留顶层项、hub 外壳、两个 socket），再给一段在沙箱里逐项探读、探连的脚本。
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

export interface SandboxDataDir {
  dataDir: string;
  stateDir: string;
  /** Worker 自己的 worktree（cwd）。 */
  own: string;
  /** 这个会话自己的启动目录 state/launch/7。 */
  launchDir: string;
  hubSock: string;
  adminSock: string;
  /** 探测脚本要的环境变量。 */
  env: Record<string, string>;
  close(): Promise<void>;
}

/** 数据目录里不该被 Worker 读到的文件（相对数据目录）和探测脚本里对应的标记。 */
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

/** 数据目录里 Worker 要能读到的（相对数据目录）和标记。 */
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

/** root 要短（macOS 的 Unix socket 路径最多 103 字节）。 */
export async function makeSandboxDataDir(root: string): Promise<SandboxDataDir> {
  const dataDir = join(root, "home");
  const stateDir = join(dataDir, "state");
  const own = join(dataDir, "worktrees", "1", "2");
  const launchDir = join(stateDir, "launch", "7");
  mkdirSync(own, { recursive: true });
  for (const [rel] of [...DENIED_PROBES, ...ALLOWED_PROBES]) write(join(dataDir, rel), `${rel}\n`);
  const hub = join(dataDir, "run", "bin", "hub");
  write(hub, "#!/bin/sh\necho HUB_RAN\n");
  chmodSync(hub, 0o755);
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
    close: async () => {
      await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    },
  };
}

/**
 * 在沙箱里跑的探测脚本（/bin/sh -c）：读到一个就打一行标记，列目录看得到密钥、备份的名字也打，能连上 socket 也打。
 * 另外确认工作目录照常（cd 进去、pwd -P 解析真实路径）、hub 外壳能执行。
 */
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
    ...[...DENIED_PROBES, ...ALLOWED_PROBES].map(([rel, mark]) => `cat "$D/${rel}" >/dev/null 2>&1 && echo ${mark}`),
    // macOS 上整个列不出来；Linux 上数据目录是 tmpfs，只列得出放行项挂回时留下的空壳：两种都不该看到密钥、备份的名字
    'ls -a "$D/state" 2>/dev/null | grep -qx ui-token && echo STATE_LISTED',
    'ls -a "$D" 2>/dev/null | grep -qx backups && echo DATA_DIR_LISTED',
    'cd "$O" && test "$(pwd -P)" = "$O" && echo CWD_OK',
    '"$D/run/bin/hub" 2>/dev/null',
    `"$N" -e '${connect}'`,
  ].join("; ");
}

/** 普通 Worker、只读 Worker 跑完探测脚本应该打出的标记（顺序同脚本）。 */
export const EXPECTED_PROBE_OUTPUT: readonly string[] = [
  ...ALLOWED_PROBES.map(([, mark]) => mark),
  "CWD_OK",
  "HUB_RAN",
  "HUB_CONNECTED",
];
