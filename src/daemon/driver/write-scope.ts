// 把通用的 Worker 可写范围（shared/write-scope.ts）翻译成每家的机制。键是 AGENT_VENDORS：加厂商漏了这里编译不过，
// 新厂商只要实现 WriteScopeEnforcer，再在驱动起进程时调 spawnInWriteScope（和下面三家一样）。
// - macOS：三家都把整个进程包在 macOS 沙箱（sandbox-exec）里：数据目录禁写、自己的工作目录放行。编辑工具（在 CLI 进程里写）、
//   shell 命令、它们起的所有子进程都在里面，一起管住；连 hub.sock 是网络操作，不受影响。
//   macOS 沙箱不能嵌套（已在沙箱里的进程再起 sandbox-exec 报 sandbox_apply: Operation not permitted），所以包了的进程不能再开自带的沙箱：
//   - claude：--settings 里写 sandbox.enabled: false（policy.ts 的 buildSessionSettings；--settings 压过用户和项目设置）。
//     不用 claude 自带的：它的 sandbox.filesystem 写规则拒绝总压过放行，没法在拒绝的数据目录里再放行工作目录。
//   - agy：终端沙箱（--sandbox，或用户设置里 enableTerminalSandbox: true）：包了的进程加 --settings {"enableTerminalSandbox":false}
//     （ownSandboxOffArgs；--settings 是这一次会话的设置）。实测开着时在 sandbox-exec 里命令 exit 71。
//   - codex：turn/start 的 sandboxPolicy 用 externalSandbox（codex 不再自己起 sandbox-exec，命令和改文件都在外面这层里），
//     审批照样按范围判断（codex-protocol.ts）。只读 Worker 例外：codex 自己的 readOnly 沙箱已经什么都写不了，进程不包。
// - 只读 Worker 的 agy（只有 agy 用外层沙箱，另两家有自己的只读机制）：readonlySeatbeltProfile——哪里都不能写（会话私有临时目录、agy 运行时目录、
//   通用缓存目录除外），密钥禁读；命令行是 sandbox-exec -p <profile> agy …，设置文件里已经关了 agy 自带的终端沙箱。见 readonly-agy.ts。
// - 别的系统（没有 sandbox-exec，以后上 Linux 服务器）：不包，起 Worker 时记一条警告，各家用兜底，能拦多少拦多少（不报错、不拦 Worker）：
//   claude 设置文件里 state/ 的 Edit 拒绝规则（只管编辑工具）；agy 按工具参数和命令行字面检查（agy-protocol.ts 的 checkWorkerToolViolation）；
//   codex 自己的 workspace-write 沙箱（writableRoots 去掉数据目录里不能写的）加审批按字面检查。已知局限见 docs/write-scope.md。
import type { AgentVendor, WriteScope } from "../../shared/index.ts";

export interface SpawnCommand {
  command: string;
  args: string[];
}

export interface ScopedSpawn extends SpawnCommand {
  /** 可写范围有没有被 OS 沙箱管住。有可写范围却是 false（没有 sandbox-exec）时，驱动层只能用各家的兜底。 */
  osSandboxed: boolean;
}

export interface WriteScopeEnforcer {
  /** 起厂商进程前调：返回实际要起的命令。scope 是 null（项目经理）时原样返回。 */
  spawnCommand(base: SpawnCommand, scope: WriteScope | null, platform?: NodeJS.Platform): ScopedSpawn;
  /** 没有 OS 沙箱时这家靠什么兜底，写进警告日志。 */
  fallback: string;
  /** 包进 OS 沙箱时加在命令行最前面、关掉这家自带沙箱的参数（不能嵌套，见文件头）。claude、codex 不在命令行上关（设置文件、sandboxPolicy）。 */
  ownSandboxOffArgs: readonly string[];
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** 这台机器能不能用 OS 沙箱（sandbox-exec 只有 macOS 有）。launch.ts 按它决定 claude 的设置文件里关不关自带沙箱。 */
export function osSandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}
/** SBPL 字符串字面量：" 和 \ 前面加 \。 */
function sbplString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

/** SBPL 正则字面量 #"…"：里面的反斜杠原样给正则（不能像字符串那样双写），只转义 "。 */
function sbplRegex(re: string): string {
  return `#"${re.replace(/"/g, '\\"')}"`;
}

/**
 * sandbox-exec 的规则：别的都放行，数据目录禁写，再放行自己的工作目录（规则后面的压过前面的）。
 * 路径要是真实路径（沙箱按解析后的路径比，大小写不敏感的盘上大小写不同也拦得住，实测）。
 */
export function seatbeltProfile(scope: WriteScope): string {
  const lines = ["(version 1)", "(allow default)", `(deny file-write* (subpath ${sbplString(scope.dataDir)}))`];
  for (const dir of scope.writableDirs) lines.push(`(allow file-write* (subpath ${sbplString(dir)}))`);
  return lines.join("\n");
}

/** 包一层 sandbox-exec（macOS），进程的参数前面加上 ownSandboxOffArgs；scope 是 null 或不是 macOS 就原样返回。 */
export function wrapInSeatbelt(
  base: SpawnCommand,
  scope: WriteScope | null,
  platform: NodeJS.Platform = process.platform,
  ownSandboxOffArgs: readonly string[] = [],
): ScopedSpawn {
  if (scope === null || !osSandboxAvailable(platform)) return { ...base, osSandboxed: false };
  return { command: SANDBOX_EXEC, args: ["-p", seatbeltProfile(scope), base.command, ...ownSandboxOffArgs, ...base.args], osSandboxed: true };
}

/** 外层只读沙箱的参数（readonly-agy.ts 的 agyReadonlySandboxInput 按厂商生成）：路径都是 realpath 过的绝对路径。 */
export interface ReadonlySandboxInput {
  /** 这个会话自己的私有临时目录（TMPDIR 指到这，退出时删）。 */
  tmpDir: string;
  /** 厂商运行时目录、通用缓存目录：整个子树可写。 */
  writableDirs: string[];
  /** 具体的可写文件（正则，已转义，^…$ 整个路径）。 */
  writableFileRegexes: string[];
  /** 禁读的路径（目录按子树算）。 */
  secretPaths: string[];
  /** 禁读的通配（任意目录下的 .env、id_rsa* 这种，写法见 readonly-policy.ts），转成正则。 */
  secretGlobs: string[];
}

/** 设备文件：写 /dev/null 这类要放行，不然 shell 重定向、终端都坏。 */
const SEATBELT_DEVICE_WRITES =
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))';

/** 密钥通配转 SBPL 正则：只认开头的“任意目录/”和文件名里的 *（* 不跨目录）。路径都是绝对路径，所以前面补一个 /。 */
export function secretGlobRegex(glob: string): string {
  const tail = glob.replace(/^\*\*\//, "");
  return `/${tail.split("*").map((part) => part.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&")).join("[^/]*")}$`;
}

/**
 * 只读的 sandbox-exec 规则（设计 4.1）：别的放行，哪里都不能写，再放行设备文件、会话私有临时目录、厂商运行时和缓存目录，最后密钥禁读（规则后面的压过前面的）。
 * 路径要是真实路径（沙箱按解析后的路径比）。
 */
export function readonlySeatbeltProfile(input: ReadonlySandboxInput): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    SEATBELT_DEVICE_WRITES,
    ...[input.tmpDir, ...input.writableDirs].map((dir) => `(allow file-write* (subpath ${sbplString(dir)}))`),
    ...input.writableFileRegexes.map((re) => `(allow file-write* (regex ${sbplRegex(re)}))`),
    ...input.secretPaths.map((p) => `(deny file-read* (subpath ${sbplString(p)}))`),
    ...input.secretGlobs.map((g) => `(deny file-read* (regex ${sbplRegex(secretGlobRegex(g))}))`),
  ].join("\n");
}

/**
 * 只读 Worker 的进程包一层只读 sandbox-exec（macOS）；不是 macOS 原样返回（osSandboxed: false，调用方决定报错）。
 * 厂商自带沙箱要在它自己的设置里关（readonly-agy.ts 的 agyReadonlySettings），这里不加参数。
 */
export function wrapInReadonlySeatbelt(base: SpawnCommand, input: ReadonlySandboxInput, platform: NodeJS.Platform = process.platform): ScopedSpawn {
  if (!osSandboxAvailable(platform)) return { ...base, osSandboxed: false };
  return { command: SANDBOX_EXEC, args: ["-p", readonlySeatbeltProfile(input), base.command, ...base.args], osSandboxed: true };
}

function osSandboxEnforcer(fallback: string, ownSandboxOffArgs: readonly string[] = []): WriteScopeEnforcer {
  return { spawnCommand: (base, scope, platform) => wrapInSeatbelt(base, scope, platform, ownSandboxOffArgs), fallback, ownSandboxOffArgs };
}

/** agy 关掉自带终端沙箱的参数。 */
export const AGY_SANDBOX_OFF_ARGS: readonly string[] = ["--settings", JSON.stringify({ enableTerminalSandbox: false })];

export const WRITE_SCOPE_ENFORCERS: Readonly<Record<AgentVendor, WriteScopeEnforcer>> = {
  claude: osSandboxEnforcer("只剩设置文件里 state/ 的 Edit 拒绝规则（管编辑工具，管不住 shell）"),
  agy: osSandboxEnforcer("只剩按工具参数和命令行字面的检查（看不出脚本里拼出来的路径）", AGY_SANDBOX_OFF_ARGS),
  codex: osSandboxEnforcer("只剩 codex 自己的 workspace-write 沙箱加审批按命令行字面的检查（看不出脚本里拼出来的路径）"),
};

/**
 * 驱动层起厂商进程都走这里：按这家的 enforcer 包好命令；有可写范围却没有 OS 沙箱时记一条警告（不拦 Worker），
 * 返回值的 osSandboxed 告诉驱动层要不要自己兜底。
 */
export function spawnInWriteScope(
  vendor: AgentVendor,
  base: SpawnCommand,
  scope: WriteScope | null,
  log: (line: string) => void,
  sessionLabel: string,
  platform: NodeJS.Platform = process.platform,
): ScopedSpawn {
  const enforcer = WRITE_SCOPE_ENFORCERS[vendor];
  const launch = enforcer.spawnCommand(base, scope, platform);
  if (scope !== null && !launch.osSandboxed) {
    log(`[write-scope] ${sessionLabel}: 警告：这台机器（${platform}）还没有 OS 沙箱（目前只有 macOS 有），Worker 的可写范围（数据目录里只能写自己的工作目录）退回到规则兜底，不是强制的：${enforcer.fallback}`);
  }
  return launch;
}
