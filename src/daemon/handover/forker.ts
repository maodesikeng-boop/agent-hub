import type { AgentSessionRow, SessionId, TokenUsage } from "../../shared/domain.ts";
import type { LaunchFiles } from "../../shared/driver.ts";
import type { ForkHandle, ForkerKind } from "../../shared/handover.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { isAgentVendor } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";

export type { ForkHandle } from "../../shared/handover.ts";

export interface ForkSource {
  sessionId: SessionId;
  vendor: AgentVendor;
  vendorSessionId: string;
  executablePath: string;
  cwd: string;
  addDirs: string[];
  model: string | null;
  effort: string | null;
  launch: LaunchFiles;
}

export interface ForkWriteResult {
  text: string;
  usage: TokenUsage;
}

export class ForkUnsupportedError extends Error {
  override name = "ForkUnsupportedError";
}

export interface SessionForker {
  readonly id: string;
  readonly kind: ForkerKind;
  fork(src: ForkSource, signal: AbortSignal): Promise<ForkHandle>;
  write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult>;
  remove(fork: ForkHandle): Promise<void>;
}

export type ForkerRegistry = Readonly<Record<AgentVendor, readonly SessionForker[]>>;

export function findForker(registry: ForkerRegistry, vendor: string, id: string): SessionForker | null {
  if (!isAgentVendor(vendor)) return null;
  return registry[vendor].find((f) => f.id === id) ?? null;
}

export function withoutHubEnv(launch: LaunchFiles): LaunchFiles {
  const { [ENV_HUB_TOKEN]: _token, [ENV_HUB_SOCK]: _sock, ...env } = launch.env;
  return { ...launch, env };
}

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
