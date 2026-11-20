import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  RequestError,
  client,
  methods,
  type AnyMessage,
  type SessionNotification,
  type Stream,
} from "@agentclientprotocol/sdk/unstable";
import { scanSecretGlobs, type ReadonlySandboxInput } from "../../../daemon/driver/write-scope.ts";
import { MAX_MESSAGE_BYTES, PRODUCT_NAME, type ReadonlyPolicy } from "../../../shared/index.ts";
import { realpathOrSelf, type AcpProc } from "./driver-state.ts";
import { decideAcpPermission } from "./protocol.ts";
import type { AcpDriverConfig, AcpLaunchContext } from "./types.ts";

export async function buildAcpReadonlySandboxInput(
  sandboxCfg: AcpDriverConfig["readonlySandbox"],
  launch: AcpLaunchContext,
  policy: ReadonlyPolicy,
): Promise<{ input: ReadonlySandboxInput; cleanupTmp: () => void }> {
  const rawTmp = mkdtempSync(join(tmpdir(), "agent-hub-acp-ro-"));
  const tmpDir = realpathOrSelf(rawTmp);
  let cleaned = false;
  const cleanupTmp = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    }
  };

  const { row } = launch;
  const homeDir = realpathOrSelf(homedir());
  const realCwd = realpathOrSelf(row.cwd);
  const defaultCaches = [
    join(homeDir, ".cache"),
    join(homeDir, "Library", "Caches"),
    join(homeDir, ".npm"),
  ];
  const extraDirs = sandboxCfg?.writableDirs?.(homeDir, realCwd, launch) ?? [];
  const writableDirs = [
    ...new Set(
      [...defaultCaches, ...extraDirs]
        .filter((d) => existsSync(d))
        .map(realpathOrSelf),
    ),
  ];
  const writableFileGlobs = [
    ...(sandboxCfg?.writableFileGlobs?.(homeDir, realCwd, launch) ?? []),
  ];
  const readableFiles = [...new Set((sandboxCfg?.readableFiles?.(homeDir) ?? []).map(realpathOrSelf))];
  const policySecretPaths = [...policy.secretPaths, ...(sandboxCfg?.hiddenPaths?.(homeDir, realCwd, launch) ?? [])].map(realpathOrSelf);

  const allSecretPaths =
    process.platform === "linux" || process.platform === "win32"
      ? [
          ...new Set([
            ...policySecretPaths,
            ...(await scanSecretGlobs([realCwd, ...row.addDirs.map(realpathOrSelf)], policy.secretGlobs)),
          ]),
        ]
      : [...new Set(policySecretPaths)];
  const secretPaths = allSecretPaths.filter((p) => !readableFiles.includes(p));
  const roProtectedRoots = launch.files.writeScope?.protectedRoots ?? policy.protectedRoots;

  return {
    input: {
      tmpDir,
      ...(policy.stateDir ? { stateDir: policy.stateDir } : {}),
      ...(roProtectedRoots ? { protectedRoots: roProtectedRoots } : {}),
      writableDirs,
      writableFileGlobs,
      writableFileRegexes: [],
      secretPaths,
      secretGlobs: [...policy.secretGlobs],
      ...(readableFiles.length > 0 ? { readableFiles } : {}),
      ...(policy.dataDirScope ? { dataDirScope: policy.dataDirScope } : {}),
    },
    cleanupTmp,
  };
}

export function createAcpStdioStream(
  child: ChildProcessWithoutNullStreams,
  handlers: { onWriteFailure(): void; onPromptWritten(): void },
): { stream: Stream; readableController: ReadableStreamDefaultController<AnyMessage> | null } {
  let readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
  const readable = new ReadableStream<AnyMessage>({
    start(controller) {
      readableController = controller;
    },
    cancel() {
      readableController = null;
    },
  });
  const writable = new WritableStream<AnyMessage>({
    write: (message) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        handlers.onWriteFailure();
        throw new Error("ACP stdin is closed");
      }
      const serialized = JSON.stringify(message)
        .replaceAll(" ", "\\u2028")
        .replaceAll(" ", "\\u2029");
      return new Promise<void>((resolve, reject) => {
        child.stdin.write(`${serialized}\n`, (error) => {
          if (error) {
            handlers.onWriteFailure();
            reject(error);
            return;
          }
          if ("method" in message && message.method === "session/prompt") {
            handlers.onPromptWritten();
          }
          resolve();
        });
      });
    },
  });
  return { stream: { readable, writable }, readableController };
}

export function createAcpClientApp(
  config: AcpDriverConfig,
  deps: {
    proc(): AcpProc;
    isShuttingDown(): boolean;
    onSessionUpdate(params: SessionNotification): void;
  },
): ReturnType<typeof client> {
  const clientInfo = config.clientInfo ?? { name: PRODUCT_NAME, version: "0.0.0" };
  return client({ name: clientInfo.name })
    .onRequest(methods.client.session.requestPermission, async (ctx) => {
      const proc = deps.proc();
      const outcome = await decideAcpPermission(
        {
          request: ctx.params,
          readonlyPolicy: proc.readonlyPolicy,
          closing: proc.closing !== null || deps.isShuttingDown(),
          signal: ctx.signal,
        },
        config.permissions,
      );
      return { outcome };
    })
    .onRequest(methods.client.elicitation.create, async (ctx) => {
      if (config.extensions?.onElicitation) {
        return config.extensions.onElicitation(ctx.params, ctx.signal);
      }
      return { action: "decline" };
    })
    .onRequest("*", async (ctx) => {
      if (config.extensions?.onBlockingRequest) {
        const proc = deps.proc();
        const result = await config.extensions.onBlockingRequest({
          method: ctx.method,
          params: ctx.params,
          requestId: ctx.requestId,
          signal: ctx.signal,
          agent: ctx.agent,
          sessionId: proc.acpSessionId,
          readonlyPolicy: proc.readonlyPolicy,
        });
        if (result !== undefined) return result;
      }
      throw RequestError.methodNotFound(ctx.method);
    })
    .onNotification(methods.client.session.update, (ctx) => {
      deps.onSessionUpdate(ctx.params);
    })
    .onNotification("*", (ctx) => {
      config.extensions?.onNotification?.({
        method: ctx.method,
        params: ctx.params,
        sessionId: deps.proc().acpSessionId,
      });
    });
}

// JSON escaping can inflate text up to 6x; reserve extra room for the envelope.
export function guardAcpFrameSize(child: ChildProcessWithoutNullStreams, onOverflow: () => void): void {
  let partialLineBytes = 0;
  let overflowed = false;
  child.stdout.prependListener("data", (chunk: string) => {
    if (overflowed) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      partialLineBytes += Buffer.byteLength(nl < 0 ? chunk.slice(start) : chunk.slice(start, nl));
      if (partialLineBytes > MAX_MESSAGE_BYTES * 8) {
        overflowed = true;
        child.stdout.destroy();
        onOverflow();
        return;
      }
      if (nl < 0) break;
      partialLineBytes = 0;
      start = nl + 1;
    }
  });
}
