import {
  PROTOCOL_VERSION,
  RequestError,
  methods,
  type InitializeResponse,
  type McpServer,
  type SessionConfigOption,
  type SessionModeState,
  type SystemPrompt,
} from "@agentclientprotocol/sdk/unstable";
import { errorMessage } from "../../../daemon/driver/base-driver.ts";
import { personaSeenAtStart } from "../../../daemon/driver/persona-note.ts";
import { PRODUCT_NAME, type AgentSessionRow } from "../../../shared/index.ts";
import type { AcpDriverHost, AcpProc, AcpSessionState, AcpSystemPromptInjection } from "./driver-state.ts";
import {
  activeModelFromConfigOptions,
  defaultIsAcpSessionNotFoundError,
  flattenConfigSelectOptions,
  readAcpSystemPrompt,
  resolveEffortConfigUpdate,
  resolveModelConfigUpdate,
} from "./protocol.ts";
import { closeOpenTools, flushTextBuffer } from "./turn-stream.ts";
import type { AcpLaunchContext } from "./types.ts";

interface AcpSessionParams {
  mcpServers: McpServer[];
  additionalDirectories: string[] | undefined;
  sessionMeta: Record<string, unknown> | undefined;
  injection: AcpSystemPromptInjection;
  supportsNativeSystemPrompt: boolean;
  nativeSystemPrompt: SystemPrompt | undefined;
}

interface OpenedAcpSession {
  sessionId: string;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  resumed: boolean;
}

export async function runAcpHandshake(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  launchCtx: AcpLaunchContext,
): Promise<void> {
  const { row, files } = launchCtx;
  try {
    const init = await initializeAndAuthenticate(host, proc, launchCtx);
    const params = buildSessionParams(host, init, launchCtx);
    const opened = await openAcpSession(host, st, proc, init, row, params);

    proc.acpSessionId = opened.sessionId;
    proc.modes = opened.modes;
    proc.configOptions = opened.configOptions;
    st.hasConversation = true;

    if (!params.supportsNativeSystemPrompt && params.injection !== "never") proc.reinjectPromptFile = files.promptFile;
    if (
      !params.supportsNativeSystemPrompt &&
      (params.injection === "every_process_first_turn" ||
        (params.injection === "first_turn_new_session" && !opened.resumed))
    ) {
      proc.pendingSystemPromptBlock = readAcpSystemPrompt(
        files.promptFile,
        host.config.session?.formatSystemPrompt,
      );
    }

    await applyDefaultMode(host, proc, init, launchCtx, opened);
    // Switching the model can return a new list of effort options.
    await applyAcpConfigOptions(host, proc, opened.sessionId, row.model, row.effort);
    markHandshakeReady(host, st, proc, row, params.injection, opened);
  } catch (error) {
    failHandshake(host, st, proc, error);
  }
}

async function initializeAndAuthenticate(
  host: AcpDriverHost,
  proc: AcpProc,
  launchCtx: AcpLaunchContext,
): Promise<InitializeResponse> {
  const clientInfo = host.config.clientInfo ?? { name: PRODUCT_NAME, version: "0.0.0" };
  const init = await proc.acpConn.agent.request(methods.agent.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientInfo,
    clientCapabilities: host.clientCapabilities(),
  });
  proc.initResponse = init;

  const authCfg = host.config.authenticate;
  const shouldAuth =
    typeof authCfg?.enabled === "function"
      ? authCfg.enabled(init, launchCtx)
      : Boolean(authCfg?.enabled);
  if (shouldAuth) {
    const authMethods = init.authMethods ?? [];
    const methodId = authCfg?.selectMethodId
      ? authCfg.selectMethodId(authMethods, init, launchCtx)
      : authCfg?.preferredMethodId && authMethods.some((m) => m.id === authCfg.preferredMethodId)
        ? authCfg.preferredMethodId
        : (authCfg?.preferredMethodId ?? authMethods[0]?.id ?? null);
    if (methodId !== null) {
      await proc.acpConn.agent.request(methods.agent.authenticate, { methodId });
    }
  }
  return init;
}

function buildSessionParams(
  host: AcpDriverHost,
  init: InitializeResponse,
  launchCtx: AcpLaunchContext,
): AcpSessionParams {
  const { row, files } = launchCtx;
  const mcpServersCfg = host.config.session?.mcpServers;
  const mcpServers: McpServer[] =
    typeof mcpServersCfg === "function"
      ? [...mcpServersCfg(launchCtx)]
      : mcpServersCfg
        ? [...mcpServersCfg]
        : [];
  const extraDirs = host.config.session?.extraAdditionalDirectories?.(launchCtx) ?? [];
  const mergedDirs: string[] = [];
  const seenDirs = new Set<string>();
  for (const dir of [...row.addDirs, ...extraDirs]) {
    const trimmed = dir.trim();
    if (trimmed === "" || trimmed === row.cwd || seenDirs.has(trimmed)) continue;
    seenDirs.add(trimmed);
    mergedDirs.push(trimmed);
  }
  // Only sent when the agent advertises sessionCapabilities.additionalDirectories; others reply -32602.
  const additionalDirectories =
    mergedDirs.length > 0 && init.agentCapabilities?.sessionCapabilities?.additionalDirectories
      ? mergedDirs
      : undefined;
  const sessionMeta = host.config.session?.sessionMeta?.(launchCtx);

  const injection = host.systemPromptInjection();
  const supportsNativeSystemPrompt = Boolean(
    host.config.session?.preferNativeSystemPrompt &&
      init.agentCapabilities?.sessionCapabilities?.systemPrompt,
  );
  let nativeSystemPrompt: SystemPrompt | undefined;
  if (supportsNativeSystemPrompt && injection !== "never") {
    const rawText = readAcpSystemPrompt(files.promptFile, (s) => s);
    if (rawText) {
      nativeSystemPrompt = { mode: "append", content: [{ type: "text", text: rawText }] };
    }
  }
  return { mcpServers, additionalDirectories, sessionMeta, injection, supportsNativeSystemPrompt, nativeSystemPrompt };
}

function sessionExtras(params: AcpSessionParams): {
  additionalDirectories?: string[];
  systemPrompt?: SystemPrompt;
  _meta?: Record<string, unknown>;
} {
  return {
    ...(params.additionalDirectories ? { additionalDirectories: params.additionalDirectories } : {}),
    ...(params.nativeSystemPrompt ? { systemPrompt: params.nativeSystemPrompt } : {}),
    ...(params.sessionMeta && Object.keys(params.sessionMeta).length > 0 ? { _meta: params.sessionMeta } : {}),
  };
}

async function openAcpSession(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  init: InitializeResponse,
  row: AgentSessionRow,
  params: AcpSessionParams,
): Promise<OpenedAcpSession> {
  const wantResume = proc.resume && row.vendorSessionId.trim() !== "";
  const continued = wantResume ? await continueSavedSession(host, st, proc, init, row, params) : null;
  if (continued) return continued;
  const created = await proc.acpConn.agent.request(methods.agent.session.new, {
    cwd: row.cwd,
    mcpServers: params.mcpServers,
    ...sessionExtras(params),
  });
  return {
    sessionId: created.sessionId,
    modes: created.modes ?? null,
    configOptions: [...(created.configOptions ?? [])],
    resumed: false,
  };
}

async function continueSavedSession(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  init: InitializeResponse,
  row: AgentSessionRow,
  params: AcpSessionParams,
): Promise<OpenedAcpSession | null> {
  const continuation = host.config.continuation;
  const modeSetting = continuation?.mode ?? "auto";
  const useResumeRpc =
    modeSetting === "resume" ||
    (modeSetting === "auto" && Boolean(init.agentCapabilities?.sessionCapabilities?.resume));
  const swallowReplay = continuation?.swallowReplayOnLoad !== false;
  try {
    if (useResumeRpc) {
      try {
        const resumed = await proc.acpConn.agent.request(methods.agent.session.resume, {
          sessionId: row.vendorSessionId,
          cwd: row.cwd,
          mcpServers: params.mcpServers,
          ...sessionExtras(params),
        });
        return {
          sessionId: row.vendorSessionId,
          modes: resumed.modes ?? null,
          configOptions: [...(resumed.configOptions ?? [])],
          resumed: true,
        };
      } catch (error) {
        if (!(error instanceof RequestError) || error.code !== -32601 || !init.agentCapabilities?.loadSession) throw error;
        return await loadSavedSession(host, st, proc, row, params, swallowReplay);
      }
    }
    return await loadSavedSession(host, st, proc, row, params, swallowReplay);
  } catch (contErr) {
    proc.swallowingReplay = false;
    if (proc.closing !== null || proc.streamEnded || host.isShuttingDown()) {
      throw contErr;
    }
    const isMissing = host.config.errors?.isSessionNotFoundError ?? defaultIsAcpSessionNotFoundError;
    const unsupported = contErr instanceof RequestError && contErr.code === -32601;
    const allowFallback = continuation?.fallbackToNewOnFailure !== false && (isMissing(contErr) || unsupported);
    if (!allowFallback) {
      throw contErr;
    }
    host.logSession(
      st.id,
      `ACP 恢复会话 ${row.vendorSessionId} 失败（${errorMessage(contErr)}），回退新建会话`,
    );
    return null;
  }
}

async function loadSavedSession(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  row: AgentSessionRow,
  params: AcpSessionParams,
  swallowReplay: boolean,
): Promise<OpenedAcpSession> {
  proc.swallowingReplay = swallowReplay;
  try {
    const loaded = await proc.acpConn.agent.request(methods.agent.session.load, {
      sessionId: row.vendorSessionId,
      cwd: row.cwd,
      mcpServers: params.mcpServers,
      ...sessionExtras(params),
    });
    // Let replay notifications queued from the same stdout chunk run before replay swallowing ends.
    await Promise.resolve();
    await Promise.resolve();
    if (!swallowReplay) {
      const replayAt = Date.now();
      flushTextBuffer(host, st, proc, replayAt);
      closeOpenTools(host, st, proc, replayAt);
    }
    return {
      sessionId: row.vendorSessionId,
      modes: loaded.modes ?? null,
      configOptions: [...(loaded.configOptions ?? [])],
      resumed: true,
    };
  } finally {
    proc.swallowingReplay = false;
  }
}

async function applyDefaultMode(
  host: AcpDriverHost,
  proc: AcpProc,
  init: InitializeResponse,
  launchCtx: AcpLaunchContext,
  opened: OpenedAcpSession,
): Promise<void> {
  const { modes, sessionId } = opened;
  const modeCfg = host.config.session?.defaultModeId;
  const targetModeId =
    typeof modeCfg === "function"
      ? modeCfg({
          row: launchCtx.row,
          files: launchCtx.files,
          resumed: opened.resumed,
          sessionId,
          init,
          modes,
          configOptions: proc.configOptions,
        })
      : (modeCfg ?? null);
  if (!targetModeId) return;
  if (modes && modes.availableModes.some((m) => m.id === targetModeId)) {
    if (modes.currentModeId !== targetModeId) {
      await proc.acpConn.agent.request(methods.agent.session.setMode, { sessionId, modeId: targetModeId });
    }
    return;
  }
  // Agents that dropped the legacy modes field expose the mode as a config option instead.
  const modeOption = proc.configOptions.find((o) => o.type === "select" && (o.category === "mode" || o.id === "mode"));
  if (
    modeOption?.type === "select" &&
    modeOption.currentValue !== targetModeId &&
    flattenConfigSelectOptions(modeOption).some((c) => c.value === targetModeId)
  ) {
    await setConfigOption(proc, sessionId, modeOption.id, targetModeId);
  }
}

async function setConfigOption(proc: AcpProc, sessionId: string, configId: string, value: string): Promise<void> {
  const res = await proc.acpConn.agent.request(methods.agent.session.setConfigOption, {
    sessionId,
    configId,
    value,
  });
  if (Array.isArray(res.configOptions)) {
    proc.configOptions = [...res.configOptions];
  }
}

async function applyAcpConfigOptions(
  host: AcpDriverHost,
  proc: AcpProc,
  sessionId: string,
  requestedModel: string | null,
  requestedEffort: string | null,
): Promise<void> {
  const cfg = host.config.configOptions;
  if (cfg?.combineModelAndEffort) {
    const combined = cfg.combineModelAndEffort({
      model: requestedModel,
      effort: requestedEffort,
      options: proc.configOptions,
    });
    if (combined !== null) {
      for (const item of combined) {
        await setConfigOption(proc, sessionId, item.configId, item.value);
      }
      return;
    }
  }

  const modelUpdate = resolveModelConfigUpdate(requestedModel, proc.configOptions, cfg);
  if (modelUpdate) await setConfigOption(proc, sessionId, modelUpdate.configId, modelUpdate.value);

  const effortUpdate = resolveEffortConfigUpdate(requestedEffort, proc.configOptions, cfg);
  if (effortUpdate) await setConfigOption(proc, sessionId, effortUpdate.configId, effortUpdate.value);
}

function markHandshakeReady(
  host: AcpDriverHost,
  st: AcpSessionState,
  proc: AcpProc,
  row: AgentSessionRow,
  injection: AcpSystemPromptInjection,
  opened: OpenedAcpSession,
): void {
  if (proc.streamEnded || st.proc !== proc) return;
  if (proc.closing !== null) {
    proc.resolveReady({ kind: "closed", reason: proc.closing });
    return;
  }

  if (st.stopRequested) {
    host.sigintForInterrupt(st, proc);
    proc.resolveReady({ kind: "closed", reason: "interrupt" });
    return;
  }
  host.clearTimer(st, "startTimer");
  proc.initSeen = true;
  st.resumeHint = true;
  host.markHealthy(st.id);

  const rebaked =
    injection === "every_process_first_turn" ||
    !opened.resumed ||
    Boolean(host.config.continuation?.rebakesPersonaOnResume);
  const seen = personaSeenAtStart(st, host.row(st), proc.personaLaunched, rebaked);
  host.setPersonaSeen(st, seen);

  const at = Date.now();
  host.update(st, { vendorSessionId: opened.sessionId, status: "running", lastEventAt: at });
  const activeModel =
    activeModelFromConfigOptions(proc.configOptions, host.config.configOptions) ??
    (row.model && row.model !== "" ? row.model : null);
  host.emit(st.id, {
    type: "session.started",
    resumed: opened.resumed,
    model: activeModel,
    tools: [],
    at,
  });
  proc.resolveReady({ kind: "ok" });
}

function failHandshake(host: AcpDriverHost, st: AcpSessionState, proc: AcpProc, error: unknown): void {
  if (proc.streamEnded) return;
  if (proc.closing !== null) {
    proc.resolveReady({ kind: "closed", reason: proc.closing });
    return;
  }
  proc.resolveReady({
    kind: "failed",
    exitCode: proc.child.exitCode,
    signal: proc.child.signalCode,
    stderr: proc.stderr,
    timedOut: proc.startTimedOut,
    errorMessage: errorMessage(error),
  });
  if (!proc.child.stdin.destroyed && !proc.child.stdin.writableEnded) {
    proc.child.stdin.end();
  }
  host.forceKillProc(st, proc);
}
