import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  DriverError,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  ENV_SESSION_OWNER_TAG,
  INHERIT_WORKER_CAPABILITIES,
  REVIEW_HOOKS_DIR,
  REVIEW_PRE_PUSH_HOOK,
  WORKER_BACKGROUND_HOLD_MAX_MS,
  buildReadonlyPolicy,
  dataDirReadScope,
  isAgentVendor,
  resolveOuterSandboxLaunchMode,
  resolveSessionCapabilities,
  reviewPushGuardEnv,
  taskGraphSkillCatalogEntry,
  vendorSpec,
  workerCapabilityPolicy,
  workerWriteScope,
} from "../shared/index.ts";
import type {
  AgentSessionRow,
  AgentVendor,
  CapabilityInventory,
  CapabilityPolicy,
  LaunchContext,
  LaunchFiles,
  Ledger,
  PersonaNote,
  PersonaUpdate,
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
import { makeSessionOwnerTag } from "./platform/index.ts";
import type { SessionTmpStore } from "./session-tmp.ts";
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
  capabilityPolicies?: Pick<Ledger, "getPmCapabilityPolicy" | "getRouterCapabilityPolicy">;
  capabilityInventory?: Pick<CapabilityInventoryService, "get">;
  workerPlatform?: NodeJS.Platform;
  prepareOsSandbox?: (input: OsSandboxLaunchPrep) => Promise<void>;
  sessionTmp: Pick<SessionTmpStore, "allocate">;
  sessionTagNonce?: string;
  parentSessionTag?: string;
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

async function sessionCapabilities(
  inventory: LaunchPreparerOptions["capabilityInventory"],
  vendor: string,
  readPolicy: () => CapabilityPolicy | undefined,
  projectDir: string | null,
): Promise<{ capabilities?: SessionCapabilities; capabilityFingerprint?: string; inventory?: CapabilityInventory }> {
  if (inventory === undefined || !isAgentVendor(vendor)) return {};
  const snapshot = await inventory.get({ projectDir });
  const policy = readPolicy();
  if (policy === undefined) return {};
  const capabilities = resolveSessionCapabilities(policy, snapshot, vendor) ?? undefined;
  const launch = capabilities === undefined ? undefined : VENDOR_DAEMONS[vendor].capabilityLaunch?.(capabilities);
  const external = inventoryFingerprint(snapshot, vendor);
  const capabilityFingerprint = external === undefined && launch === undefined ? undefined : hash([external, launch]);
  return { capabilities, capabilityFingerprint, inventory: snapshot };
}

const inventoryFingerprints = new WeakMap<CapabilityInventory, Map<AgentVendor, string | undefined>>();

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function inventoryFingerprint(snapshot: CapabilityInventory, vendor: AgentVendor): string | undefined {
  let cached = inventoryFingerprints.get(snapshot);
  if (cached === undefined) {
    cached = new Map();
    inventoryFingerprints.set(snapshot, cached);
  }
  if (cached.has(vendor)) return cached.get(vendor);
  const items = snapshot.items
    .filter((item) => item.vendors.includes(vendor))
    .map((item) => [item.key, item.skillDirs?.[vendor] ?? item.dir, item.plugins?.[vendor], item.description]);
  const fingerprint = items.length === 0 ? undefined : hash(items);
  cached.set(vendor, fingerprint);
  return fingerprint;
}

function agentCapabilityReader(options: LaunchPreparerOptions, vendor: AgentVendor | null, ctx: LaunchContext) {
  const { capabilityInventory, capabilityPolicies } = options;
  if (capabilityInventory === undefined || capabilityPolicies === undefined || vendor === null) return undefined;
  const pmId = ctx.pm.id;
  const worker = ctx.role === "worker" ? ctx.workerCapabilities ?? INHERIT_WORKER_CAPABILITIES : null;
  const projectDir = ctx.project?.mainFolder.trim() || null;
  return () => sessionCapabilities(capabilityInventory, vendor, () => {
    const project = capabilityPolicies.getPmCapabilityPolicy(pmId);
    return worker === null ? project : workerCapabilityPolicy(project, worker);
  }, projectDir);
}

async function prepareRouterLaunch(
  options: LaunchPreparerOptions,
  session: AgentSessionRow,
  env: {
    basePath: string;
    homeDir: string;
    prepareOsSandbox: (input: OsSandboxLaunchPrep) => Promise<void>;
    tmpDir: string;
    ownerTag: string;
    ownerEnv: string;
  },
): Promise<LaunchFiles> {
  const { launchDir, dataDir, stateDir } = options;
  const { capabilities } = await sessionCapabilities(options.capabilityInventory, session.vendor, () => options.capabilityPolicies?.getRouterCapabilityPolicy(), null);
  const files = prepareRouterSandboxLaunch(session, {
    launchDir,
    dataDir,
    stateDir,
    protectedRoots: options.protectedRoots?.(),
    homeDir: env.homeDir,
    osSandboxed: options.osSandboxed,
    tokens: options.tokens,
    hubSock: options.hubSock,
    hubBinDir: options.hubBinDir,
    basePath: env.basePath,
    vendorAvailability: options.vendorAvailability?.(),
    purpose: options.routerPurposeOf?.(session.id) ?? "dispatch",
    tmpDir: env.tmpDir,
    ownerTag: env.ownerTag,
    ownerEnv: env.ownerEnv,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  await env.prepareOsSandbox({ dataDir, stateDir, writeScope: files.writeScope ?? null, readonly: files.readonly });
  return files;
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
  const tagNonce = options.sessionTagNonce ?? randomBytes(6).toString("hex");
  return async (session) => {
    const basePath = resolveBasePath();
    const ownerTag = `s${session.id}:${tagNonce}`;
    const ownerEnv = makeSessionOwnerTag(session.id, tagNonce, options.parentSessionTag ?? process.env[ENV_SESSION_OWNER_TAG]);
    if (session.role === "assistant") {
      const tmpDir = options.sessionTmp.allocate(session.id);
      return prepareRouterLaunch(options, session, { basePath, homeDir, prepareOsSandbox, tmpDir, ownerTag, ownerEnv });
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
    const readCapabilities = agentCapabilityReader(options, vendor, ctx);
    const { capabilities, capabilityFingerprint, inventory } = (await readCapabilities?.()) ?? {};
    const getOuterMode = (latest: LaunchContext, caps?: SessionCapabilities, scanned?: CapabilityInventory) => {
      const approval = latest.outerSandboxApproval ?? null;
      if (approval === null) return "enforced";
      if (vendor === null || latest.worker === null || approval.workerId !== latest.worker.id) throw new DriverError("spawn_failed", "沙箱批准与 Worker 不匹配");
      const mode = resolveOuterSandboxLaunchMode({
        vendor, platform: options.workerPlatform ?? process.platform, workerStatus: latest.worker.status,
        readonly: latest.worker.readonly, approval, sessionCapabilities: caps, inventory: scanned,
      });
      if (mode.mode === "block") throw new DriverError("spawn_failed", mode.reason);
      return mode.mode;
    };
    const outerSandbox = ctx.outerSandboxApproval == null ? "enforced" : getOuterMode(getLaunchContext(session.id), capabilities, inventory);
    const nativeReadonly = readonlyPolicy !== undefined && vendor !== null && vendorSpec(vendor).capabilities.readonly === "settings";
    const buildVendorFiles = vendor === null ? undefined : VENDOR_DAEMONS[vendor].launchFiles;
    const vendorInput = {
      role,
      readonly: nativeReadonly ? { policy: readonlyPolicy, denyWrite: [session.cwd, ...session.addDirs].map(realpathOr) } : undefined,
      hubSock,
      stateDir,
      osSandboxed: outerSandbox === "enforced" && osSandboxed,
    };
    const vendorFiles = buildVendorFiles?.({ ...vendorInput, capabilities });
    const settings = vendorFiles?.settings;
    const baseSettings = settings !== undefined && capabilities !== undefined
      ? buildVendorFiles?.(vendorInput)?.settings
      : settings;
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
    const tmpDir = role === "worker" ? options.sessionTmp.allocate(session.id) : undefined;
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
    if (outerSandbox === "enforced") await prepareOsSandbox({ dataDir, stateDir, writeScope, readonly: readonlyPolicy });
    return {
      promptFile,
      ...(settingsFile === undefined ? {} : { settingsFile }),
      ...(skillsDir === undefined ? {} : { skillsDir }),
      ownerTag,
      env: {
        [ENV_HUB_TOKEN]: tokens.issue(session.id),
        [ENV_HUB_SOCK]: hubSock,
        [ENV_SESSION_OWNER_TAG]: ownerEnv,
        PATH: basePath === "" ? hubBinDir : `${hubBinDir}${delimiter}${basePath}`,
        ...(tmpDir === undefined ? {} : { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir }),
        ...vendorFiles?.env,
        ...reviewEnv,
      },
      // Persona and mode are excluded from the fingerprint so edits do not restart the process; the driver adds a note before the next message instead.
      fingerprint: launchFingerprint({
        prompt: buildFingerprintPrompt(ctx, session.cwd, promptOptions),
        settings: baseSettings ?? "",
        readonly: readonlyPolicy,
        ...(skillsDir === undefined ? {} : { skills: taskGraphSkillCatalogEntry() }),
      }),
      personaRevision: role === "pm" ? ctx.pm.personaRevision : undefined,
      ...(writeScope === null ? {} : { writeScope }),
      ...(outerSandbox === "vendor_only" ? { outerSandbox } : {}),
      ...(readonlyPolicy === undefined
        ? tmpDir === undefined ? {} : { tmpDir }
        : { readonly: readonlyPolicy, tmpDir: tmpDir ?? options.sessionTmp.allocate(session.id) }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(readCapabilities === undefined ? {} : {
        capabilityCheck: {
          fingerprint: capabilityFingerprint,
          currentFingerprint: async () => {
            const current = await readCapabilities();
            if (outerSandbox === "vendor_only") getOuterMode(getLaunchContext(session.id), current.capabilities, current.inventory);
            return current.capabilityFingerprint;
          },
        },
      }),
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
