// 把通用的 Worker 可写范围（shared/write-scope.ts）翻译成每家的机制。键是 AGENT_VENDORS：加厂商漏了这里编译不过，
// 新厂商只要实现 WriteScopeEnforcer，再在驱动起进程时调它的 spawnCommand（和下面三家一样）。
// - claude、agy：整个进程包在 macOS 沙箱（sandbox-exec）里：数据目录禁写、自己的工作目录放行。编辑工具（在 CLI 进程里写）、
//   shell 命令、它们起的所有子进程都在里面，一起管住；连 hub.sock 是网络操作，不受影响。
//   为什么不用它们自带的：claude 的 sandbox.filesystem 写规则只有放行和拒绝，拒绝总压过放行（2.1.314 生成沙箱规则的代码先写放行、后写拒绝），
//   没法在拒绝的数据目录里再放行工作目录，而且一开就把数据目录以外的写入和网络也收紧了；agy 的终端沙箱（--sandbox）
//   同样只能整体收紧（只能写工作区、断网）。两家都没开自带沙箱，外面包一层不冲突。
// - codex：自己有沙箱（workspace-write，只能写 writableRoots 和临时目录），外面不能再包一层：macOS 沙箱不能嵌套
//   （实测已在沙箱里的进程再起 sandbox-exec 报 sandbox_apply: Operation not permitted，codex 的命令都靠它跑，会全失败）。
//   所以 codex 不包进程，在协议里落实：writableRoots 去掉数据目录里不能写的，要越出沙箱的命令和改沙箱外文件的审批按范围拒
//   （codex-protocol.ts 的 buildSandboxPolicy、decideCommandApproval、decideFileChangeApproval）。
// 只在 macOS 上有 sandbox-exec；别的系统 claude、agy 不包（这个项目先在这台 Mac 上用）。
import type { AgentVendor, WriteScope } from "../../shared/index.ts";

export interface SpawnCommand {
  command: string;
  args: string[];
}

export interface WriteScopeEnforcer {
  /** 起厂商进程前调：返回实际要起的命令。scope 是 null（项目经理）时原样返回。 */
  spawnCommand(base: SpawnCommand, scope: WriteScope | null): SpawnCommand;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** SBPL 字符串字面量：" 和 \ 前面加 \。 */
function sbplString(s: string): string {
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
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

/** 包一层 sandbox-exec（macOS）；scope 是 null 或不是 macOS 就原样返回。 */
export function wrapInSeatbelt(base: SpawnCommand, scope: WriteScope | null, platform: NodeJS.Platform = process.platform): SpawnCommand {
  if (scope === null || platform !== "darwin") return base;
  return { command: SANDBOX_EXEC, args: ["-p", seatbeltProfile(scope), base.command, ...base.args] };
}

const osSandbox: WriteScopeEnforcer = { spawnCommand: (base, scope) => wrapInSeatbelt(base, scope) };
/** codex 自己的沙箱管（见文件头），进程不包。 */
const vendorSandbox: WriteScopeEnforcer = { spawnCommand: (base) => base };

export const WRITE_SCOPE_ENFORCERS: Readonly<Record<AgentVendor, WriteScopeEnforcer>> = {
  claude: osSandbox,
  agy: osSandbox,
  codex: vendorSandbox,
};
