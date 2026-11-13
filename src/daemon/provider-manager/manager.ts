// Settings → Providers 统一管理状态机（docs/providers-install-login-design.md 第 6、8 章）：
// - 固定 AGENT_VENDORS.length（6 个槽位）恒定 O(6) 内存，零无限增长列表；
// - `GET /api/providers` 不带 `refresh=1` 时严格 0 子进程拉起；
// - 安装/更新异步秒回、支持取消整树强杀、装完即时刷新 `VendorRuntimeResolver` 与单家 `ModelCatalogs`；
// - 界面内登录流支持 `800ms` 首包等待、跨客户端 `ownerKey` 脱敏隔离、以及 6 重防 SSRF 远端回环回调转发。
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  AGENT_VENDORS,
  PROVIDER_API_KEY_MAX_CHARS,
  PROVIDER_AUTH_FLOW_TIMEOUT_MS,
  PROVIDER_AUTH_INPUT_MAX_CHARS,
  PROVIDER_AUTH_START_WAIT_MS,
  PROVIDER_INSTALL_TIMEOUT_MS,
  vendorSpec,
  type AgentVendor,
  type ProviderAuthFlowPhase,
  type ProviderAuthFlowSnapshot,
  type ProviderAuthManualInput,
  type ProviderCancelAuthRequest,
  type ProviderCancelJobRequest,
  type ProviderJobKind,
  type ProviderJobPhase,
  type ProviderJobSnapshot,
  type ProviderLogoutRequest,
  type ProviderSaveApiKeyRequest,
  type ProviderStartAuthRequest,
  type ProviderStatusItem,
  type ProviderSubmitAuthRequest,
  type ProvidersStatusResponse,
} from "../../shared/index.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type {
  AuthFlowHooks,
  VendorInstallRecipe,
  VendorSetupAdapter,
  VendorSetupContext,
  VendorUpdateRecipe,
} from "../../vendors/daemon-types.ts";
import {
  forwardValidatedLoopbackCallback,
  parseLoopbackCallbackContract,
  validateLoopbackCallbackUrl,
  type LoopbackCallbackContract,
} from "../../vendors/_common/setup/loopback-callback.ts";
import {
  createVendorVersionCache,
  type VendorVersionCache,
} from "../../vendors/_common/setup/version-probe.ts";
import type { ModelCatalogs } from "../driver/model-catalog.ts";
import {
  executeInstallRecipe,
  executeUpdateRecipe,
  executeWindowsGitInstall,
  withInstallTimeoutSignal,
  type RecipeExecutionContext,
} from "./recipes.ts";
import { BoundedJobLogBuffer, redactProviderLog } from "./redact.ts";
import type { VendorRuntimeResolver } from "./runtime-resolver.ts";

export class ProviderRequestError extends Error {
  readonly statusCode: 400 | 403 | 404 | 409;
  constructor(statusCode: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "ProviderRequestError";
    this.statusCode = statusCode;
  }
}

interface ActiveJobSlot {
  jobId: string;
  kind: ProviderJobKind;
  phase: ProviderJobPhase;
  logBuffer: BoundedJobLogBuffer;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  controller: AbortController;
  cancelledByUser: boolean;
  promise: Promise<void>;
}

interface ActiveAuthFlowSlot {
  flowId: string;
  methodId: string;
  ownerKey: string;
  phase: ProviderAuthFlowPhase;
  authorizeUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  manualInput: ProviderAuthManualInput;
  loopbackContract: LoopbackCallbackContract | null;
  inputHandler: ((input: string) => void | Promise<void>) | null;
  error: string | null;
  expiresAt: number;
  controller: AbortController;
  cancelledByUser: boolean;
  expiredByTimer: boolean;
  promise: Promise<void>;
}

interface VendorSlot {
  job: ActiveJobSlot | null;
  authFlow: ActiveAuthFlowSlot | null;
}

export interface ProviderRecipeRunner {
  install(recipe: VendorInstallRecipe, ctx: RecipeExecutionContext): Promise<void>;
  update(
    updateRecipe: VendorUpdateRecipe,
    installRecipe: VendorInstallRecipe,
    binaryPath: string,
    ctx: RecipeExecutionContext,
  ): Promise<void>;
  installGit(ctx: RecipeExecutionContext): Promise<void>;
}

const DEFAULT_RECIPE_RUNNER: ProviderRecipeRunner = {
  install: executeInstallRecipe,
  update: executeUpdateRecipe,
  installGit: executeWindowsGitInstall,
};

export interface ProviderManagerOptions {
  runtime: VendorRuntimeResolver;
  models: ModelCatalogs;
  adapters?: Partial<Record<AgentVendor, VendorSetupAdapter>>;
  versionCache?: VendorVersionCache;
  recipeRunner?: ProviderRecipeRunner;
  forwardLoopback?: typeof forwardValidatedLoopbackCallback;
  execPath?: string;
  installTimeoutMs?: number;
  authFlowTimeoutMs?: number;
  authStartWaitMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface ProviderManager {
  getStatus(options: { refresh?: boolean; ownerKey: string }): Promise<ProvidersStatusResponse>;
  install(vendor: AgentVendor, ownerKey: string): Promise<ProviderStatusItem>;
  update(vendor: AgentVendor, ownerKey: string): Promise<ProviderStatusItem>;
  cancelJob(vendor: AgentVendor, req: ProviderCancelJobRequest, ownerKey: string): Promise<ProviderStatusItem>;
  installGit(ownerKey: string): Promise<ProvidersStatusResponse>;
  startAuth(vendor: AgentVendor, req: ProviderStartAuthRequest, ownerKey: string): Promise<ProviderStatusItem>;
  submitAuth(vendor: AgentVendor, req: ProviderSubmitAuthRequest, ownerKey: string): Promise<ProviderStatusItem>;
  cancelAuth(vendor: AgentVendor, req: ProviderCancelAuthRequest, ownerKey: string): Promise<ProviderStatusItem>;
  saveApiKey(vendor: AgentVendor, req: ProviderSaveApiKeyRequest, ownerKey: string): Promise<ProviderStatusItem>;
  logout(vendor: AgentVendor, req: ProviderLogoutRequest, ownerKey: string): Promise<ProviderStatusItem>;
  close(): Promise<void>;
}

function isFlowInProgress(phase: ProviderAuthFlowPhase): boolean {
  return (
    phase === "starting" ||
    phase === "waiting_browser" ||
    phase === "waiting_device_code" ||
    phase === "verifying"
  );
}

function snapshotOfJob(job: ActiveJobSlot | null): ProviderJobSnapshot | null {
  if (!job) return null;
  return {
    jobId: job.jobId,
    kind: job.kind,
    phase: job.phase,
    progressLine: job.phase === "running" ? job.logBuffer.progressLine : null,
    error: job.error,
    logTail: job.phase === "failed" || job.phase === "cancelled" ? job.logBuffer.toString() : "",
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function snapshotOfAuthFlow(
  flow: ActiveAuthFlowSlot | null,
  viewerOwnerKey: string,
): ProviderAuthFlowSnapshot | null {
  if (!flow) return null;
  const ownedByOther = flow.ownerKey !== viewerOwnerKey;
  return {
    flowId: flow.flowId,
    methodId: flow.methodId,
    phase: flow.phase,
    authorizeUrl: ownedByOther ? null : flow.authorizeUrl,
    verificationUrl: ownedByOther ? null : flow.verificationUrl,
    userCode: ownedByOther ? null : flow.userCode,
    manualInput: flow.manualInput,
    ownedByOtherClient: ownedByOther,
    error: flow.error,
    expiresAt: flow.expiresAt,
  };
}

export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  const { runtime, models } = options;
  const versionCache = options.versionCache ?? createVendorVersionCache();
  const recipeRunner = options.recipeRunner ?? DEFAULT_RECIPE_RUNNER;
  const forwardLoopback = options.forwardLoopback ?? forwardValidatedLoopbackCallback;
  const execPath = options.execPath ?? process.execPath;
  const installTimeoutMs = options.installTimeoutMs ?? PROVIDER_INSTALL_TIMEOUT_MS;
  const authFlowTimeoutMs = options.authFlowTimeoutMs ?? PROVIDER_AUTH_FLOW_TIMEOUT_MS;
  const authStartWaitMs = options.authStartWaitMs ?? PROVIDER_AUTH_START_WAIT_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});

  let closed = false;
  let gitJob: ActiveJobSlot | null = null;

  // 固定 AGENT_VENDORS.length 槽位，跑一个月内存恒定 O(6)
  const slots = new Map<AgentVendor, VendorSlot>(
    AGENT_VENDORS.map((vendor) => [vendor, { job: null, authFlow: null }]),
  );

  const adapterOf = (vendor: AgentVendor): VendorSetupAdapter | undefined =>
    options.adapters?.[vendor] ?? VENDOR_DAEMONS[vendor]?.setup;

  const assertOpen = () => {
    if (closed) {
      throw new ProviderRequestError(409, "Provider manager is shutting down");
    }
  };

  const buildSetupContext = (vendor: AgentVendor): VendorSetupContext => ({
    platform: runtime.platform,
    userHome: runtime.userHome,
    availability: models.availability(vendor),
    executablePath: () => runtime.resolveExecutablePath(vendor),
    installed: () => runtime.installed(vendor),
    env: () => runtime.resolveVendorEnv(vendor),
    secrets: runtime.secrets,
  });

  const buildVendorItem = async (vendor: AgentVendor, viewerOwnerKey: string): Promise<ProviderStatusItem> => {
    const slot = slots.get(vendor)!;
    const adapter = adapterOf(vendor);
    const binaryPath = runtime.locateBinary(vendor);
    const installed = binaryPath !== null;
    const availability = models.availability(vendor);
    const version = installed ? versionCache.peek(vendor, binaryPath) : null;

    if (!adapter) {
      return {
        vendor,
        label: vendorSpec(vendor).label,
        installed,
        version,
        availability,
        accountSummary: null,
        canInstall: false,
        canUpdate: false,
        canSignOut: false,
        authMethods: [],
        job: snapshotOfJob(slot.job),
        authFlow: snapshotOfAuthFlow(slot.authFlow, viewerOwnerKey),
      };
    }

    const authInfo = await adapter.inspectAuth(buildSetupContext(vendor));
    const jobRunning = slot.job?.phase === "running";

    return {
      vendor,
      label: vendorSpec(vendor).label,
      installed,
      version,
      availability,
      accountSummary: installed ? authInfo.accountSummary : null,
      canInstall: !installed && !jobRunning,
      canUpdate: installed && !jobRunning,
      canSignOut: installed && authInfo.canSignOut && !jobRunning,
      authMethods: authInfo.methods,
      job: snapshotOfJob(slot.job),
      authFlow: snapshotOfAuthFlow(slot.authFlow, viewerOwnerKey),
    };
  };

  const refreshVendorAfterChange = async (vendor: AgentVendor, probeVer: boolean): Promise<void> => {
    runtime.refreshSystemPath();
    runtime.invalidate(vendor);
    if (probeVer) {
      versionCache.invalidate(vendor);
      const binaryPath = runtime.locateBinary(vendor);
      if (binaryPath !== null && !closed) {
        const adapter = adapterOf(vendor);
        await versionCache.probe(vendor, binaryPath, {
          args: adapter?.versionArgs,
          cwd: runtime.userHome,
          env: runtime.resolveVendorEnv(vendor),
        });
      }
    }
    if (!closed && runtime.installed(vendor)) {
      await models.list({ vendor, refresh: true }).catch(() => undefined);
    }
  };

  const startVendorJob = async (
    vendor: AgentVendor,
    kind: ProviderJobKind,
    ownerKey: string,
  ): Promise<ProviderStatusItem> => {
    assertOpen();
    const adapter = adapterOf(vendor);
    if (!adapter) {
      throw new ProviderRequestError(400, `Setup is not supported for ${vendorSpec(vendor).label}`);
    }
    const slot = slots.get(vendor)!;
    // 幂等：正在跑同厂商安装/更新时直接返回当前快照
    if (slot.job?.phase === "running") {
      return buildVendorItem(vendor, ownerKey);
    }
    if (slot.authFlow && isFlowInProgress(slot.authFlow.phase)) {
      throw new ProviderRequestError(409, "Sign-in is currently in progress for this provider");
    }
    if (kind === "update" && !runtime.installed(vendor)) {
      throw new ProviderRequestError(400, `${vendorSpec(vendor).label} is not installed yet`);
    }

    const controller = new AbortController();
    const logBuffer = new BoundedJobLogBuffer({
      initialProgress: kind === "install" ? "Starting installer…" : "Updating CLI…",
    });
    const job: ActiveJobSlot = {
      jobId: randomUUID(),
      kind,
      phase: "running",
      logBuffer,
      error: null,
      startedAt: now(),
      finishedAt: null,
      controller,
      cancelledByUser: false,
      promise: Promise.resolve(),
    };
    slot.job = job;

    const installRecipe = adapter.installRecipe(runtime.platform);
    const updateRecipe = adapter.updateRecipe(runtime.platform);
    const currentBin = runtime.resolveExecutablePath(vendor);

    job.promise = (async () => {
      const timeoutGuard = withInstallTimeoutSignal(controller.signal, installTimeoutMs);
      try {
        const recipeCtx: RecipeExecutionContext = {
          platform: runtime.platform,
          userHome: runtime.userHome,
          toolsNpmDir: runtime.paths.toolsNpmDir,
          toolsNpmBinDir: runtime.paths.toolsNpmBinDir,
          execPath,
          env: runtime.resolveVendorEnv(vendor),
          logBuffer,
          signal: timeoutGuard.signal,
          purpose: `provider:${kind}:${vendor}`,
        };
        if (kind === "install") {
          await recipeRunner.install(installRecipe, recipeCtx);
        } else {
          await recipeRunner.update(updateRecipe, installRecipe, currentBin, recipeCtx);
        }
        await refreshVendorAfterChange(vendor, true);
        if (!runtime.installed(vendor)) {
          job.phase = "failed";
          job.error = "Installer exited cleanly, but the CLI executable was not found afterwards";
        } else {
          job.phase = "succeeded";
        }
      } catch (err) {
        if (job.cancelledByUser || closed) {
          job.phase = "cancelled";
          job.error = null;
        } else if (timeoutGuard.didTimeout()) {
          job.phase = "failed";
          job.error = `Timed out after ${Math.round(installTimeoutMs / 60_000)} minutes`;
        } else {
          job.phase = "failed";
          const rawMsg = err instanceof Error ? err.message : String(err);
          job.error = redactProviderLog(rawMsg).slice(0, 300);
          log(`[providers] ${vendor} ${kind} failed: ${job.error}`);
        }
      } finally {
        timeoutGuard.cleanup();
        job.finishedAt = now();
      }
    })();

    return buildVendorItem(vendor, ownerKey);
  };

  const abortAndWaitAuthFlow = async (slot: VendorSlot): Promise<void> => {
    const current = slot.authFlow;
    if (!current || !isFlowInProgress(current.phase)) return;
    current.cancelledByUser = true;
    current.controller.abort();
    await current.promise.catch(() => undefined);
  };

  return {
    async getStatus({ refresh = false, ownerKey }) {
      if (refresh && !closed) {
        runtime.refreshSystemPath();
        versionCache.invalidate();
        await Promise.all([
          models.list({ refresh: true }).catch(() => undefined),
          ...AGENT_VENDORS.map(async (vendor) => {
            const bin = runtime.locateBinary(vendor);
            if (!bin) return;
            await versionCache.probe(vendor, bin, {
              args: adapterOf(vendor)?.versionArgs,
              cwd: runtime.userHome,
              env: runtime.resolveVendorEnv(vendor),
            });
          }),
        ]);
      }

      const providers = await Promise.all(
        AGENT_VENDORS.map((vendor) => buildVendorItem(vendor, ownerKey)),
      );
      const gitInstalled = runtime.gitInstalled();
      return {
        platform: runtime.platform,
        gitInstalled,
        canInstallGit: runtime.platform === "win32" && !gitInstalled && gitJob?.phase !== "running",
        gitJob: snapshotOfJob(gitJob),
        providers,
      };
    },

    install(vendor, ownerKey) {
      return startVendorJob(vendor, "install", ownerKey);
    },

    update(vendor, ownerKey) {
      return startVendorJob(vendor, "update", ownerKey);
    },

    async cancelJob(vendor, req, ownerKey) {
      const slot = slots.get(vendor)!;
      if (!slot.job || slot.job.jobId !== req.jobId) {
        throw new ProviderRequestError(404, "Active job not found");
      }
      if (slot.job.phase === "running") {
        slot.job.cancelledByUser = true;
        slot.job.controller.abort();
        await slot.job.promise.catch(() => undefined);
      }
      return buildVendorItem(vendor, ownerKey);
    },

    async installGit(ownerKey) {
      assertOpen();
      if (runtime.platform !== "win32") {
        throw new ProviderRequestError(400, "Automatic Git installation is only supported on Windows");
      }
      if (gitJob?.phase === "running") {
        return this.getStatus({ ownerKey });
      }
      const controller = new AbortController();
      const logBuffer = new BoundedJobLogBuffer({ initialProgress: "Installing Git via WinGet…" });
      const job: ActiveJobSlot = {
        jobId: randomUUID(),
        kind: "install",
        phase: "running",
        logBuffer,
        error: null,
        startedAt: now(),
        finishedAt: null,
        controller,
        cancelledByUser: false,
        promise: Promise.resolve(),
      };
      gitJob = job;

      job.promise = (async () => {
        const timeoutGuard = withInstallTimeoutSignal(controller.signal, installTimeoutMs);
        try {
          await recipeRunner.installGit({
            platform: runtime.platform,
            userHome: runtime.userHome,
            toolsNpmDir: runtime.paths.toolsNpmDir,
            toolsNpmBinDir: runtime.paths.toolsNpmBinDir,
            execPath,
            env: runtime.resolveVendorEnv(AGENT_VENDORS[0]),
            logBuffer,
            signal: timeoutGuard.signal,
            purpose: "provider:install:git",
          });
          runtime.refreshSystemPath();
          job.phase = runtime.gitInstalled() ? "succeeded" : "failed";
          if (job.phase === "failed") {
            job.error = "WinGet completed, but git.exe was not found in PATH";
          }
        } catch (err) {
          if (job.cancelledByUser || closed) {
            job.phase = "cancelled";
          } else if (timeoutGuard.didTimeout()) {
            job.phase = "failed";
            job.error = "Git installation timed out";
          } else {
            job.phase = "failed";
            job.error = redactProviderLog(err instanceof Error ? err.message : String(err)).slice(0, 300);
          }
        } finally {
          timeoutGuard.cleanup();
          job.finishedAt = now();
        }
      })();

      return this.getStatus({ ownerKey });
    },

    async startAuth(vendor, req, ownerKey) {
      assertOpen();
      const adapter = adapterOf(vendor);
      if (!adapter?.startAuthFlow) {
        throw new ProviderRequestError(400, `Interactive sign-in is not supported for ${vendorSpec(vendor).label}`);
      }
      const slot = slots.get(vendor)!;
      if (slot.job?.phase === "running") {
        throw new ProviderRequestError(409, "Installation is currently in progress");
      }
      if (!runtime.installed(vendor)) {
        throw new ProviderRequestError(400, `${vendorSpec(vendor).label} is not installed yet`);
      }
      if (slot.authFlow && isFlowInProgress(slot.authFlow.phase)) {
        if (slot.authFlow.ownerKey !== ownerKey) {
          throw new ProviderRequestError(409, "Sign-in is already in progress in another window");
        }
        await abortAndWaitAuthFlow(slot);
      }

      const inspected = await adapter.inspectAuth(buildSetupContext(vendor));
      const descriptor = inspected.methods.find((m) => m.id === req.methodId);
      if (!descriptor || descriptor.kind === "api_key") {
        throw new ProviderRequestError(400, `Unknown interactive sign-in method: ${req.methodId}`);
      }
      const manualInput: ProviderAuthManualInput =
        descriptor.kind === "browser_oauth" ? descriptor.manualInput : "none";

      const controller = new AbortController();
      const startedAt = now();
      let readySignalResolve!: () => void;
      const readySignalPromise = new Promise<void>((resolve) => {
        readySignalResolve = resolve;
      });

      const flow: ActiveAuthFlowSlot = {
        flowId: randomUUID(),
        methodId: req.methodId,
        ownerKey,
        phase: "starting",
        authorizeUrl: null,
        verificationUrl: null,
        userCode: null,
        manualInput,
        loopbackContract: null,
        inputHandler: null,
        error: null,
        expiresAt: startedAt + authFlowTimeoutMs,
        controller,
        cancelledByUser: false,
        expiredByTimer: false,
        promise: Promise.resolve(),
      };
      slot.authFlow = flow;

      const expiryTimer = setTimeout(() => {
        if (isFlowInProgress(flow.phase)) {
          flow.expiredByTimer = true;
          controller.abort();
        }
      }, authFlowTimeoutMs);
      expiryTimer.unref();

      const hooks: AuthFlowHooks = {
        onAuthorizeUrl(url) {
          flow.authorizeUrl = url;
          flow.loopbackContract = parseLoopbackCallbackContract(url);
          if (flow.phase === "starting") {
            flow.phase = "waiting_browser";
          }
          readySignalResolve();
        },
        onDeviceCode({ verificationUrl, userCode }) {
          flow.verificationUrl = verificationUrl;
          flow.userCode = userCode;
          if (flow.phase === "starting") {
            flow.phase = "waiting_device_code";
          }
          readySignalResolve();
        },
        onUserInput(handler) {
          flow.inputHandler = handler;
        },
      };

      flow.promise = (async () => {
        try {
          await adapter.startAuthFlow!(
            buildSetupContext(vendor),
            {
              methodId: req.methodId,
              ...(req.variantId !== undefined ? { variantId: req.variantId } : {}),
              ...(req.targetId !== undefined ? { targetId: req.targetId } : {}),
              ...(req.remoteHint !== undefined ? { remoteHint: req.remoteHint } : {}),
            },
            hooks,
            controller.signal,
          );
          flow.phase = "verifying";
          await refreshVendorAfterChange(vendor, false);
          flow.phase = "succeeded";
          flow.error = null;
        } catch (err) {
          if (flow.cancelledByUser || closed) {
            flow.phase = "cancelled";
            flow.error = null;
          } else if (flow.expiredByTimer) {
            flow.phase = "expired";
            flow.error = "Sign-in session expired after 5 minutes";
          } else {
            flow.phase = "failed";
            flow.error = redactProviderLog(err instanceof Error ? err.message : String(err)).slice(0, 300);
          }
        } finally {
          clearTimeout(expiryTimer);
          readySignalResolve();
        }
      })();

      if (authStartWaitMs > 0) {
        await Promise.race([readySignalPromise, delay(authStartWaitMs)]);
      }
      return buildVendorItem(vendor, ownerKey);
    },

    async submitAuth(vendor, req, ownerKey) {
      assertOpen();
      const slot = slots.get(vendor)!;
      const flow = slot.authFlow;
      if (!flow || flow.flowId !== req.flowId || !isFlowInProgress(flow.phase)) {
        throw new ProviderRequestError(404, "Active sign-in session not found");
      }
      if (flow.ownerKey !== ownerKey) {
        throw new ProviderRequestError(403, "Sign-in session belongs to another client");
      }
      const trimmed = req.input.trim();
      if (trimmed === "" || trimmed.length > PROVIDER_AUTH_INPUT_MAX_CHARS) {
        throw new ProviderRequestError(400, "Submitted authorization input is empty or too long");
      }

      const looksLikeUrl = /^https?:\/\//iu.test(trimmed) || flow.manualInput === "callback_url";
      if (looksLikeUrl) {
        if (flow.manualInput !== "callback_url" && flow.manualInput !== "code_or_callback") {
          throw new ProviderRequestError(400, "This sign-in flow does not accept a callback URL");
        }
        const validation = validateLoopbackCallbackUrl(trimmed, flow.loopbackContract);
        if (!validation.ok) {
          throw new ProviderRequestError(400, validation.reason);
        }
        flow.phase = "verifying";
        try {
          await forwardLoopback(validation.url, { signal: flow.controller.signal });
        } catch (err) {
          const msg = redactProviderLog(err instanceof Error ? err.message : String(err)).slice(0, 240);
          throw new ProviderRequestError(400, msg);
        }
      } else {
        if (flow.manualInput !== "code" && flow.manualInput !== "code_or_callback") {
          throw new ProviderRequestError(400, "This sign-in flow requires a loopback callback URL");
        }
        if (/[\r\n\0]/u.test(trimmed)) {
          throw new ProviderRequestError(400, "Authorization code contains invalid control characters");
        }
        if (!flow.inputHandler) {
          throw new ProviderRequestError(409, "Sign-in process is not ready for code input yet");
        }
        flow.phase = "verifying";
        await flow.inputHandler(trimmed);
      }

      if (authStartWaitMs > 0) {
        await Promise.race([flow.promise.catch(() => undefined), delay(authStartWaitMs)]);
      }
      return buildVendorItem(vendor, ownerKey);
    },

    async cancelAuth(vendor, req, ownerKey) {
      const slot = slots.get(vendor)!;
      const flow = slot.authFlow;
      if (!flow || flow.flowId !== req.flowId) {
        throw new ProviderRequestError(404, "Active sign-in session not found");
      }
      if (flow.ownerKey !== ownerKey) {
        throw new ProviderRequestError(403, "Sign-in session belongs to another client");
      }
      await abortAndWaitAuthFlow(slot);
      return buildVendorItem(vendor, ownerKey);
    },

    async saveApiKey(vendor, req, ownerKey) {
      assertOpen();
      const adapter = adapterOf(vendor);
      if (!adapter?.saveApiKey) {
        throw new ProviderRequestError(400, `API key configuration is not supported for ${vendorSpec(vendor).label}`);
      }
      const slot = slots.get(vendor)!;
      if (slot.job?.phase === "running") {
        throw new ProviderRequestError(409, "Installation is currently in progress");
      }
      const trimmedKey = req.apiKey.trim();
      if (trimmedKey === "" || trimmedKey.length > PROVIDER_API_KEY_MAX_CHARS || /[\r\n\0]/u.test(trimmedKey)) {
        throw new ProviderRequestError(400, "Invalid API key");
      }
      if (slot.authFlow && isFlowInProgress(slot.authFlow.phase)) {
        if (slot.authFlow.ownerKey !== ownerKey) {
          throw new ProviderRequestError(409, "Sign-in is currently in progress in another window");
        }
        await abortAndWaitAuthFlow(slot);
      }
      try {
        await adapter.saveApiKey(buildSetupContext(vendor), {
          ...(req.targetId !== undefined ? { targetId: req.targetId } : {}),
          apiKey: trimmedKey,
        });
      } catch (err) {
        const msg = redactProviderLog(err instanceof Error ? err.message : String(err)).slice(0, 240);
        throw new ProviderRequestError(400, msg);
      }
      await refreshVendorAfterChange(vendor, false);
      return buildVendorItem(vendor, ownerKey);
    },

    async logout(vendor, req, ownerKey) {
      assertOpen();
      const adapter = adapterOf(vendor);
      if (!adapter) {
        throw new ProviderRequestError(400, `Sign-out is not supported for ${vendorSpec(vendor).label}`);
      }
      const slot = slots.get(vendor)!;
      if (slot.job?.phase === "running") {
        throw new ProviderRequestError(409, "Installation is currently in progress");
      }
      if (slot.authFlow && isFlowInProgress(slot.authFlow.phase)) {
        if (slot.authFlow.ownerKey !== ownerKey) {
          throw new ProviderRequestError(409, "Sign-in is currently in progress in another window");
        }
        await abortAndWaitAuthFlow(slot);
      }
      await adapter.signOut(
        buildSetupContext(vendor),
        req.targetId !== undefined ? { targetId: req.targetId } : undefined,
      );
      slot.authFlow = null;
      await refreshVendorAfterChange(vendor, false);
      return buildVendorItem(vendor, ownerKey);
    },

    async close() {
      if (closed) return;
      closed = true;
      const pending: Promise<unknown>[] = [];
      if (gitJob?.phase === "running") {
        gitJob.cancelledByUser = true;
        gitJob.controller.abort();
        pending.push(gitJob.promise.catch(() => undefined));
      }
      for (const slot of slots.values()) {
        if (slot.job?.phase === "running") {
          slot.job.cancelledByUser = true;
          slot.job.controller.abort();
          pending.push(slot.job.promise.catch(() => undefined));
        }
        if (slot.authFlow && isFlowInProgress(slot.authFlow.phase)) {
          slot.authFlow.cancelledByUser = true;
          slot.authFlow.controller.abort();
          pending.push(slot.authFlow.promise.catch(() => undefined));
        }
      }
      await Promise.allSettled(pending);
    },
  };
}
