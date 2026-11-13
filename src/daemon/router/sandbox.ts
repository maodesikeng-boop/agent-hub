// Router 轨道 B 只读隔离沙箱与令牌权限守卫（docs/router-design.md §5.2、§7）：
// - 强制工作在 <stateDir>/router-home 隔离空目录（0700），禁挂任何业务目录（addDirs = []）；
// - 对全部厂商统一走 buildReadonlyPolicy + VENDOR_DAEMONS[vendor].launchFiles（零单家硬编码），禁写文件、禁读敏感目录；
// - 维护活跃 assistant 会话 → commandId 绑定表，严防 assistant 调普通 hub 命令，也严防 pm/worker 越权调 hub dispatch。
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  LedgerRequestError,
  buildReadonlyPolicy,
  isAgentVendor,
  vendorSpec,
  workerWriteScope,
  type AgentRole,
  type AgentSessionRow,
  type LaunchFiles,
  type RouterCommandId,
  type SessionId,
  type SessionTokens,
  type VendorAvailabilityMap,
} from "../../shared/index.ts";
import { launchFingerprint } from "../../shared/launch.ts";
import { removeSessionLaunchDir, sessionLaunchDir } from "../../shared/paths.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import { osSandboxAvailable } from "../driver/write-scope.ts";
import { buildRouterSystemPrompt } from "./prompt.ts";

export const ROUTER_HOME_DIR_NAME = "router-home";

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** 确保 <stateDir>/router-home 隔离空目录存在（0700）并返回真实路径。 */
export function ensureRouterHomeDir(stateDir: string): string {
  const dir = join(realpathOr(stateDir), ROUTER_HOME_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathOr(dir);
}

/** 校验准备启动的会话严格符合轨道 B 隔离沙箱约束。 */
export function assertRouterSessionSandbox(session: AgentSessionRow, routerHomeDir: string): void {
  if (session.role !== "assistant") {
    throw new Error(`Router sandbox requires role === "assistant", got "${session.role}"`);
  }
  if (realpathOr(session.cwd) !== routerHomeDir) {
    throw new Error(`Router sandbox requires cwd === "${routerHomeDir}" (router-home), got "${session.cwd}"`);
  }
  if (session.addDirs.length > 0) {
    throw new Error("Router sandbox forbids mounting business directories in addDirs");
  }
  if (session.conversationId !== null || session.pmId !== null || session.workerId !== null) {
    throw new Error("Router sandbox requires isolated session without conversationId/pmId/workerId");
  }
}

export interface RouterSandboxLaunchOptions {
  launchDir: string;
  dataDir: string;
  stateDir: string;
  protectedRoots?: readonly string[];
  homeDir?: string;
  osSandboxed?: boolean | (() => boolean);
  tokens: Pick<SessionTokens, "issue">;
  hubSock: string;
  hubBinDir: string;
  basePath?: string;
  vendorAvailability?: VendorAvailabilityMap;
}

/** 生成轨道 B 单轮只读规划会话的 LaunchFiles（统一适配全部厂商）。 */
export function prepareRouterSandboxLaunch(
  session: AgentSessionRow,
  options: RouterSandboxLaunchOptions,
): LaunchFiles {
  const routerHomeDir = ensureRouterHomeDir(options.stateDir);
  assertRouterSessionSandbox(session, routerHomeDir);

  const osSandboxed =
    typeof options.osSandboxed === "function"
      ? options.osSandboxed()
      : (options.osSandboxed ?? osSandboxAvailable());
  const homeDir = realpathOr(options.homeDir ?? homedir());
  const stateDir = realpathOr(options.stateDir);
  const dataDir = realpathOr(options.dataDir);
  const basePath = options.basePath ?? process.env.PATH ?? process.env.Path ?? "";

  const prompt = buildRouterSystemPrompt({ vendorAvailability: options.vendorAvailability });
  const readonlyPolicy = buildReadonlyPolicy({
    homeDir,
    stateDir,
    ...(options.protectedRoots && options.protectedRoots.length > 0
      ? { protectedRoots: [dataDir, ...options.protectedRoots] }
      : {}),
  });
  const vendor = isAgentVendor(session.vendor) ? session.vendor : null;
  const nativeReadonly = vendor !== null && vendorSpec(vendor).capabilities.readonly === "settings";

  const vendorFiles =
    vendor !== null
      ? VENDOR_DAEMONS[vendor].launchFiles?.({
          role: "worker",
          readonly: nativeReadonly ? { policy: readonlyPolicy, denyWrite: [routerHomeDir] } : undefined,
          hubSock: options.hubSock,
          stateDir,
          osSandboxed,
        })
      : undefined;

  const settings = vendorFiles?.settings;
  const dir = sessionLaunchDir(options.launchDir, session.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  let settingsFile: string | undefined;
  if (settings !== undefined) {
    settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, settings, { mode: 0o600 });
  }

  const writeScope = nativeReadonly
    ? null
    : workerWriteScope({
        role: "worker",
        dataDir,
        ...(options.protectedRoots && options.protectedRoots.length > 0 ? { protectedRoots: options.protectedRoots } : {}),
        cwd: routerHomeDir,
      });

  return {
    promptFile,
    ...(settingsFile === undefined ? {} : { settingsFile }),
    env: {
      [ENV_HUB_TOKEN]: options.tokens.issue(session.id),
      [ENV_HUB_SOCK]: options.hubSock,
      PATH: basePath === "" ? options.hubBinDir : `${options.hubBinDir}${delimiter}${basePath}`,
      ...vendorFiles?.env,
    },
    fingerprint: launchFingerprint({ prompt, settings: settings ?? "", readonly: readonlyPolicy }),
    ...(writeScope === null ? {} : { writeScope }),
    readonly: readonlyPolicy,
  };
}

/** 清理轨道 B 会话生成的临时启动目录。 */
export function cleanupRouterLaunchDir(launchDir: string, sessionId: SessionId): void {
  removeSessionLaunchDir(launchDir, sessionId);
}

export interface RouterSandboxGuard {
  bind(sessionId: SessionId, commandId: RouterCommandId): void;
  unbind(sessionId: SessionId): void;
  commandOf(sessionId: SessionId): RouterCommandId | null;
  assertRegularHubAllowed(role: AgentRole | null): void;
  assertCanDispatch(sessionId: SessionId, role: AgentRole | null): RouterCommandId;
  clear(): void;
}

/** 活跃轨道 B 会话与指令绑定守卫（finally 立即解绑，杜绝悬空残留）。 */
export function createRouterSandboxGuard(): RouterSandboxGuard {
  const active = new Map<SessionId, RouterCommandId>();

  return {
    bind(sessionId, commandId) {
      active.set(sessionId, commandId);
    },
    unbind(sessionId) {
      active.delete(sessionId);
    },
    commandOf(sessionId) {
      return active.get(sessionId) ?? null;
    },
    assertRegularHubAllowed(role) {
      if (role === "assistant") {
        throw new LedgerRequestError(
          "forbidden",
          "总助只读调度会话严禁调用普通 hub 命令，只能调用 hub dispatch",
        );
      }
    },
    assertCanDispatch(sessionId, role) {
      if (role !== "assistant") {
        throw new LedgerRequestError("forbidden", "只有总助调度会话可以调用 hub dispatch");
      }
      const commandId = active.get(sessionId);
      if (commandId === undefined) {
        throw new LedgerRequestError("forbidden", "总助调度会话已过期或未绑定有效指令");
      }
      return commandId;
    },
    clear() {
      active.clear();
    },
  };
}
