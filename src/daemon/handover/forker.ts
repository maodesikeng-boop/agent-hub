// 复制项目经理的会话去后台写交接（docs/background-handover-design.md 第 7 节）：各厂商只实现 SessionForker 的 fork / write / remove，
// 流程和判断在 ledger/handover.ts，调度在 runner.ts。各家的办法清单登记在 forkers.ts 的 FORKERS。
import type { AgentSessionRow, SessionId, TokenUsage } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { ForkHandle, ForkerKind } from "../../shared/handover.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { isAgentVendor } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";

export type { ForkHandle } from "../../shared/handover.ts";

/** 被复制的会话（项目经理现在这一代）。启动参数照它的来，复用驱动层现成的构造。 */
export interface ForkSource {
  sessionId: SessionId;
  vendor: AgentVendor;
  vendorSessionId: string;
  /** 这家 CLI 的可执行文件路径：runner 按 vendor 从 paths.claudePath / codexPath / agyPath 填（用户可配、测试用假的）。forker 一律用它起进程。 */
  executablePath: string;
  cwd: string;
  addDirs: string[];
  model: string | null;
  effort: string | null;
  /** prepareLaunch(项目经理会话) 的结果，env 里已经去掉 HUB_TOKEN、HUB_SOCK（withoutHubEnv）：复制那份不能派活。 */
  launch: LaunchFiles;
}

export interface ForkWriteResult {
  /** 这一轮 agent 的全部文字（claude 的 result、codex 的 agentMessage、agy 这一轮的文字）；空不空由账本判断。 */
  text: string;
  /** 复制那份这一轮的用量。 */
  usage: TokenUsage;
}

/** 这个办法这家用不了（格式不认识、找不到、厂商不支持）：跑腿的换清单里下一个办法，不算失败、不退避。 */
export class ForkUnsupportedError extends Error {
  override name = "ForkUnsupportedError";
}

export interface SessionForker {
  /** 在这家清单里唯一、发布后不改（存进 fork_ref，重启后凭它找回同一个办法来 remove），如 "claude-native"、"agy-copy"。 */
  readonly id: string;
  /** native：厂商自带；copy：自己造的（靠没公开的格式）。存进 handovers.method，排查用。 */
  readonly kind: ForkerKind;
  /** 复制一份（claude 什么都不做，只定个编号）。用不了抛 ForkUnsupportedError；signal 是超时 / 关机。 */
  fork(src: ForkSource, signal: AbortSignal): Promise<ForkHandle>;
  /** 在复制那份上跑一轮 prompt，返回这一轮 agent 的全部文字和用量。进程退出码非 0、出错就抛（跑腿的报 error）。 */
  write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult>;
  /** 删掉复制那份；幂等（不存在算成功）。只拿得到 handle：清理要用的东西 fork 时放进 handle.extra。 */
  remove(fork: ForkHandle): Promise<void>;
}

/** 办法清单，按优先顺序：厂商自带的放前面，自己造的放后面。键是 AGENT_VENDORS：加厂商漏了编译不过。空数组 = 只能本会话写交接。 */
export type ForkerRegistry = Readonly<Record<AgentVendor, readonly SessionForker[]>>;

/** 按 fork_ref 里记的 forker id 找回办法（重启后清理用）；厂商不认识、清单里没有了返回 null。 */
export function findForker(registry: ForkerRegistry, vendor: string, id: string): SessionForker | null {
  if (!isAgentVendor(vendor)) return null;
  return registry[vendor].find((f) => f.id === id) ?? null;
}

/** 去掉 hub 凭证（HUB_TOKEN、HUB_SOCK），别的照留；不改原对象。codex 的 shell_environment_policy.set 里那两个由 codex 的实现自己去。 */
export function withoutHubEnv(launch: LaunchFiles): LaunchFiles {
  const { [ENV_HUB_TOKEN]: _token, [ENV_HUB_SOCK]: _sock, ...env } = launch.env;
  return { ...launch, env };
}

/** 账本给的会话 + prepareLaunch 的结果 → ForkSource（凭证已去掉）。厂商不认识抛 ForkUnsupportedError。 */
export function forkSourceOf(session: AgentSessionRow, launch: LaunchFiles, executablePath: string): ForkSource {
  if (!isAgentVendor(session.vendor)) throw new ForkUnsupportedError(`不认识的厂商：${session.vendor}`);
  return {
    sessionId: session.id,
    vendor: session.vendor,
    vendorSessionId: session.vendorSessionId,
    executablePath,
    cwd: session.cwd,
    addDirs: [...session.addDirs],
    model: session.model,
    effort: session.effort,
    launch: withoutHubEnv(launch),
  };
}
