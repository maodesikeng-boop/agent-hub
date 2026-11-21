// Router track B runs in an isolated empty router-home with no business directories and no hub token.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  ENV_SESSION_OWNER_TAG,
  LedgerRequestError,
  buildReadonlyPolicy,
  dataDirReadScope,
  isAgentVendor,
  vendorSpec,
  workerWriteScope,
  type AgentRole,
  type AgentSessionRow,
  type LaunchFiles,
  type RouterCommandId,
  type SessionCapabilities,
  type SessionId,
  type SessionTokens,
  type VendorAvailabilityMap,
} from "../../shared/index.ts";
import { launchFingerprint } from "../../shared/launch.ts";
import { removeSessionLaunchDir, sessionLaunchDir } from "../../shared/paths.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import { dataDirDenyList, osSandboxAvailable, toolLayerReadScope } from "../driver/write-scope.ts";
import { buildCatalogSystemPrompt } from "../project-catalog/prompt.ts";
import { buildRouterSystemPrompt } from "./prompt.ts";
import type { RouterTurnPurpose } from "./single-turn.ts";

export const ROUTER_HOME_DIR_NAME = "router-home";

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function ensureRouterHomeDir(stateDir: string): string {
  const dir = join(realpathOr(stateDir), ROUTER_HOME_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return realpathOr(dir);
}

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
  purpose?: RouterTurnPurpose;
  capabilities?: SessionCapabilities;
  tmpDir?: string;
  ownerTag?: string;
  ownerEnv?: string;
}

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

  const dispatch = (options.purpose ?? "dispatch") === "dispatch";
  const prompt = dispatch ? buildRouterSystemPrompt({ vendorAvailability: options.vendorAvailability }) : buildCatalogSystemPrompt();
  const dir = sessionLaunchDir(options.launchDir, session.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const launchDir = realpathOr(dir);
  const dataDirScope = dataDirReadScope({ dataDir, launchDir, extraReadable: [routerHomeDir] });
  const readonlyPolicy = buildReadonlyPolicy({
    homeDir,
    stateDir,
    ...(options.protectedRoots && options.protectedRoots.length > 0
      ? { protectedRoots: [dataDir, ...options.protectedRoots] }
      : {}),
    dataDirScope,
    dataDirDenied: dataDirDenyList(toolLayerReadScope(dataDirScope, launchDir)),
  });
  const vendor = isAgentVendor(session.vendor) ? session.vendor : null;
  const nativeReadonly = vendor !== null && vendorSpec(vendor).capabilities.readonly === "settings";
  const { capabilities } = options;

  const vendorFiles =
    vendor !== null
      ? VENDOR_DAEMONS[vendor].launchFiles?.({
          role: "worker",
          readonly: nativeReadonly ? { policy: readonlyPolicy, denyWrite: [routerHomeDir] } : undefined,
          ...(dispatch ? { hubSock: options.hubSock } : {}),
          stateDir,
          osSandboxed,
          ...(capabilities === undefined ? {} : { capabilities }),
        })
      : undefined;
  const capabilityLaunch = capabilities !== undefined && vendor !== null ? VENDOR_DAEMONS[vendor].capabilityLaunch?.(capabilities) : undefined;

  const settings = vendorFiles?.settings;
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
        launchDir,
        ...(options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }),
      });

  return {
    promptFile,
    ...(settingsFile === undefined ? {} : { settingsFile }),
    ...(options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }),
    ...(options.ownerTag === undefined ? {} : { ownerTag: options.ownerTag }),
    env: {
      ...(dispatch
        ? {
            [ENV_HUB_TOKEN]: options.tokens.issue(session.id),
            [ENV_HUB_SOCK]: options.hubSock,
            PATH: basePath === "" ? options.hubBinDir : `${options.hubBinDir}${delimiter}${basePath}`,
          }
        : { PATH: basePath }),
      ...(options.tmpDir === undefined ? {} : { TMPDIR: options.tmpDir, TEMP: options.tmpDir, TMP: options.tmpDir }),
      ...(options.ownerEnv === undefined ? {} : { [ENV_SESSION_OWNER_TAG]: options.ownerEnv }),
      ...vendorFiles?.env,
    },
    fingerprint: launchFingerprint({
      prompt,
      settings: settings ?? "",
      readonly: readonlyPolicy,
      ...(capabilityLaunch === undefined ? {} : { capabilityLaunch }),
    }),
    ...(writeScope === null ? {} : { writeScope }),
    readonly: readonlyPolicy,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

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

/** Unbind in finally so no stale binding survives the turn. */
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
