import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  REVIEW_HOOKS_DIR,
  REVIEW_PRE_PUSH_HOOK,
  WORKER_BACKGROUND_HOLD_MAX_MS,
  buildReadonlyPolicy,
  dataDirReadScope,
  isAgentVendor,
  resolveSessionCapabilities,
  reviewPushGuardEnv,
  taskGraphSkillCatalogEntry,
  vendorSpec,
  workerWriteScope,
} from "../shared/index.ts";
import type {
  AgentSessionRow,
  LaunchContext,
  LaunchFiles,
  PersonaNote,
  PersonaUpdate,
  PmCapabilityPolicy,
  PmId,
  SessionCapabilities,
  SessionId,
  SessionRole,
  SessionTokens,
  VendorAvailabilityMap,
} from "../shared/index.ts";
import { VENDOR_DAEMONS } from "../vendors/daemon-registry.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { dataDirDenyList, osSandboxAvailable, prepareOsSandboxForLaunch, toolLayerReadScope, type OsSandboxLaunchPrep } from "./driver/write-scope.ts";
import type { CapabilityInventoryService } from "./pm-capabilities/inventory.ts";
import { truncatePmMemoryForPrompt } from "./pm-memory.ts";
import { projectWorktreesDir, sessionLaunchDir } from "../shared/paths.ts";
import { buildFingerprintPrompt, buildLaunchPrompt, personaUpdateNote } from "./prompt.ts";
import { removeProductSkills, taskGraphSkillFile, writeProductSkills } from "./task-graph-skill.ts";
import { prepareRouterSandboxLaunch } from "./router/sandbox.ts";
import type { RouterTurnPurpose } from "./router/single-turn.ts";

export interface LaunchPreparerOptions {
  launchDir: string;
  dataDir: string;
  stateDir: string;
  homeDir?: string;
  osSandboxed?: boolean | (() => boolean);
  worktreesDir: string;
  protectedRoots?: () => readonly string[];
  getLaunchContext: (sessionId: SessionId) => LaunchContext;
  tokens: Pick<SessionTokens, "issue">;
  hubSock: string;
  hubBinDir: string;
  basePath?: string | (() => string);
  vendorAvailability?: () => VendorAvailabilityMap;
  routerPurposeOf?: (sessionId: SessionId) => RouterTurnPurpose;
  getPmCapabilityPolicy?: (pmId: PmId) => PmCapabilityPolicy;
  capabilityInventory?: Pick<CapabilityInventoryService, "get">;
  prepareOsSandbox?: (input: OsSandboxLaunchPrep) => Promise<void>;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function sessionRole(ctx: LaunchContext): SessionRole {
  if (ctx.role === "pm" || ctx.role === "worker") return ctx.role;
  throw new Error(`session ${ctx.sessionId} has role ${ctx.role}; only pm and worker sessions can be launched`);
}

/** Launch files are rewritten on every start so they always match the current settings. */
export function createLaunchPreparer(options: LaunchPreparerOptions): (session: AgentSessionRow) => Promise<LaunchFiles> {
  const { launchDir, dataDir, stateDir, worktreesDir, getLaunchContext, tokens, hubSock, hubBinDir } = options;
  const resolveBasePath = () =>
    typeof options.basePath === "function"
      ? options.basePath()
      : (options.basePath ?? process.env.PATH ?? process.env.Path ?? "");
  const homeDir = realpathOr(options.homeDir ?? homedir());
  const prepareOsSandbox = options.prepareOsSandbox ?? ((input: OsSandboxLaunchPrep) => prepareOsSandboxForLaunch(input));
  return async (session) => {
    const basePath = resolveBasePath();
    if (session.role === "assistant") {
      const files = prepareRouterSandboxLaunch(session, {
        launchDir,
        dataDir,
        stateDir,
        protectedRoots: options.protectedRoots?.(),
        homeDir,
        osSandboxed: options.osSandboxed,
        tokens,
        hubSock,
        hubBinDir,
        basePath,
        vendorAvailability: options.vendorAvailability?.(),
        purpose: options.routerPurposeOf?.(session.id) ?? "dispatch",
      });
      await prepareOsSandbox({ dataDir, stateDir, writeScope: files.writeScope ?? null, readonly: files.readonly });
      return files;
    }
    const osSandboxed = typeof options.osSandboxed === "function" ? options.osSandboxed() : (options.osSandboxed ?? osSandboxAvailable());
    const rawCtx = getLaunchContext(session.id);
    const ctx: LaunchContext = {
      ...rawCtx,
      ...(rawCtx.role === "pm" ? { pm: { ...rawCtx.pm, persona: truncatePmMemoryForPrompt(rawCtx.pm.persona).text } } : {}),
    };
    const role = sessionRole(ctx);
    if (ctx.project !== null) mkdirSync(projectWorktreesDir(worktreesDir, ctx.project.id), { recursive: true });
    const dir = sessionLaunchDir(launchDir, session.id);
    const promptOptions = role === "pm" ? { taskGraphSkillFile: taskGraphSkillFile(dir) } : {};
    const prompt = buildLaunchPrompt(ctx, session.cwd, promptOptions);
    const readonly = role === "worker" && ctx.worker !== null && ctx.worker.readonly;
    const extraRoots = options.protectedRoots?.();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sessionReadable = { launchDir: realpathOr(dir), extraReadable: [session.cwd, ...session.addDirs].map(realpathOr) };
    const dataDirScope = readonly ? dataDirReadScope({ dataDir, ...sessionReadable }) : undefined;
    const readonlyPolicy =
      dataDirScope === undefined
        ? undefined
        : buildReadonlyPolicy({
            homeDir,
            stateDir,
            ...(extraRoots && extraRoots.length > 0 ? { protectedRoots: [dataDir, ...extraRoots] } : {}),
            dataDirScope,
            dataDirDenied: dataDirDenyList(toolLayerReadScope(dataDirScope, sessionReadable.launchDir)),
          });
    // Vendors that enforce readonly through settings (claude's own sandbox) are not wrapped in the outer sandbox, because sandboxes cannot nest.
    const vendor = isAgentVendor(session.vendor) ? session.vendor : null;
    let capabilities: SessionCapabilities | undefined;
    if (vendor !== null && options.getPmCapabilityPolicy && options.capabilityInventory) {
      const policy = options.getPmCapabilityPolicy(ctx.pm.id);
      const mainFolder = ctx.project?.mainFolder.trim() ?? "";
      const inv = await options.capabilityInventory.get({ projectDir: mainFolder === "" ? null : mainFolder });
      capabilities = resolveSessionCapabilities(policy, inv, vendor) ?? undefined;
    }
    const nativeReadonly = readonlyPolicy !== undefined && vendor !== null && vendorSpec(vendor).capabilities.readonly === "settings";
    const vendorFiles = vendor !== null
      ? VENDOR_DAEMONS[vendor].launchFiles?.({
          role,
          readonly: nativeReadonly ? { policy: readonlyPolicy, denyWrite: [session.cwd, ...session.addDirs].map(realpathOr) } : undefined,
          hubSock,
          stateDir,
          osSandboxed,
          ...(capabilities === undefined ? {} : { capabilities }),
        })
      : undefined;
    const settings = vendorFiles?.settings;
    const capabilityLaunch = capabilities !== undefined && vendor !== null ? VENDOR_DAEMONS[vendor].capabilityLaunch?.(capabilities) : undefined;
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, prompt, { mode: 0o600 });
    let settingsFile: string | undefined;
    if (settings !== undefined) {
      settingsFile = join(dir, "settings.json");
      writeFileSync(settingsFile, settings, { mode: 0o600 });
    }
    let skillsDir: string | undefined;
    if (role === "pm") skillsDir = writeProductSkills(dir);
    else removeProductSkills(dir);
    // Hooks live in the launch dir so Workers can execute them (git needs to) but cannot modify them.
    let reviewEnv: Record<string, string> = {};
    if (role === "worker" && ctx.worker?.review !== undefined) {
      const hooksDir = join(dir, REVIEW_HOOKS_DIR);
      mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
      const hook = join(hooksDir, "pre-push");
      writeFileSync(hook, REVIEW_PRE_PUSH_HOOK, { mode: 0o755 });
      chmodSync(hook, 0o755);
      reviewEnv = reviewPushGuardEnv(hooksDir, process.env);
    }
    const writeScope = nativeReadonly
      ? null
      : workerWriteScope({
          role,
          dataDir,
          ...(extraRoots && extraRoots.length > 0 ? { protectedRoots: extraRoots } : {}),
          cwd: session.cwd,
          addDirs: sessionReadable.extraReadable,
          launchDir: sessionReadable.launchDir,
        });
    await prepareOsSandbox({ dataDir, stateDir, writeScope, readonly: readonlyPolicy });
    return {
      promptFile,
      ...(settingsFile === undefined ? {} : { settingsFile }),
      ...(skillsDir === undefined ? {} : { skillsDir }),
      env: {
        [ENV_HUB_TOKEN]: tokens.issue(session.id),
        [ENV_HUB_SOCK]: hubSock,
        PATH: basePath === "" ? hubBinDir : `${hubBinDir}${delimiter}${basePath}`,
        ...vendorFiles?.env,
        ...reviewEnv,
      },
      // Persona and mode are excluded from the fingerprint so edits do not restart the process; the driver adds a note before the next message instead.
      fingerprint: launchFingerprint({
        prompt: buildFingerprintPrompt(ctx, session.cwd, promptOptions),
        settings: settings ?? "",
        readonly: readonlyPolicy,
        ...(skillsDir === undefined ? {} : { skills: taskGraphSkillCatalogEntry() }),
        ...(capabilityLaunch === undefined ? {} : { capabilityLaunch }),
      }),
      personaRevision: role === "pm" ? ctx.pm.personaRevision : undefined,
      ...(writeScope === null ? {} : { writeScope }),
      ...(readonlyPolicy === undefined ? {} : { readonly: readonlyPolicy }),
      ...(capabilities === undefined ? {} : { capabilities }),
      // The Worker background hold is shorter than the PM's wait so the PM is not left waiting.
      ...(role === "worker" ? { backgroundHoldMaxMs: WORKER_BACKGROUND_HOLD_MAX_MS } : {}),
    };
  };
}

export function createPersonaNoter(
  personaUpdate: (sessionId: SessionId, sinceRevision: number) => PersonaUpdate | null,
  launchDir?: string,
): (sessionId: SessionId, sinceRevision: number) => PersonaNote | null {
  return (sessionId, sinceRevision) => {
    const update = personaUpdate(sessionId, sinceRevision);
    if (update === null || update.revision === sinceRevision) return null;
    const truncatedUpdate: PersonaUpdate =
      update.persona === null
        ? update
        : {
            ...update,
            persona: {
              ...update.persona,
              text: truncatePmMemoryForPrompt(update.persona.text).text,
            },
          };
    const skillFile = launchDir === undefined ? undefined : taskGraphSkillFile(sessionLaunchDir(launchDir, sessionId));
    return { revision: update.revision, note: personaUpdateNote(truncatedUpdate, skillFile) };
  };
}
