import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanSecretGlobs,
  spawnInWriteScope,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
  type ScopedSpawn,
  type SpawnCommand,
} from "../../daemon/driver/write-scope.ts";
import {
  DriverError,
  type AgentSessionRow,
  type LaunchFiles,
  type ReadonlyPolicy,
  type WriteScope,
} from "../../shared/index.ts";
import { buildPiArgs, isValidPiSessionId } from "./protocol.ts";
import { READONLY_PI_NEEDS_SANDBOX_MESSAGE, piReadonlySandboxInput } from "./readonly.ts";
import { piTranscriptPath } from "./transcript.ts";

export interface PiLaunchDeps {
  exePath: string;
  homeDir: string | undefined;
  writeScopeSpawn: ((base: SpawnCommand, scope: WriteScope | null) => ScopedSpawn) | undefined;
  readonlySpawn: ((base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn) | undefined;
  log: Parameters<typeof spawnInWriteScope>[3];
  sessionLabel: string;
}

export interface PiLaunch {
  sessionId: string;
  effectiveFiles: LaunchFiles;
  launch: ScopedSpawn;
  tmpDir: string | null;
  childEnv: Record<string, string>;
}

async function withScannedSecrets(row: AgentSessionRow, files: LaunchFiles): Promise<ReadonlyPolicy | undefined> {
  if (files.readonly === undefined) return undefined;
  return {
    ...files.readonly,
    secretPaths: [
      ...new Set([
        ...files.readonly.secretPaths,
        ...(await scanSecretGlobs([row.cwd, ...row.addDirs], files.readonly.secretGlobs)),
      ]),
    ],
  };
}

export async function preparePiLaunch(
  row: AgentSessionRow,
  files: LaunchFiles,
  resume: boolean,
  deps: PiLaunchDeps,
): Promise<PiLaunch> {
  const existingId = row.vendorSessionId.trim();
  const sessionId = isValidPiSessionId(existingId) ? existingId : randomUUID();

  const readonlyPolicy = await withScannedSecrets(row, files);
  const effectiveFiles: LaunchFiles =
    readonlyPolicy === undefined ? files : { ...files, readonly: readonlyPolicy };

  const resumedTranscript = resume
    ? piTranscriptPath(
        { vendor: "pi", cwd: row.cwd, vendorSessionId: sessionId },
        { home: deps.homeDir, env: effectiveFiles.env },
      )
    : null;

  const args = buildPiArgs({
    row,
    files: effectiveFiles,
    sessionId,
    sessionFile: resumedTranscript,
  });
  const childEnv: Record<string, string> = { ...effectiveFiles.env };

  if (readonlyPolicy === undefined) {
    const wrapWriteScope =
      deps.writeScopeSpawn ??
      ((base, scope) => spawnInWriteScope("pi", base, scope, deps.log, deps.sessionLabel));
    const launch = wrapWriteScope({ command: deps.exePath, args }, effectiveFiles.writeScope ?? null);
    return { sessionId, effectiveFiles, launch, tmpDir: null, childEnv };
  }

  const home = realpathSync(deps.homeDir ?? homedir());
  const wrap = deps.readonlySpawn ?? ((base, input) => wrapInReadonlyOsSandbox(base, input));
  const privateTmp = mkdtempSync(join(realpathSync(tmpdir()), "agent-hub-ro-"));
  const launch = wrap(
    { command: deps.exePath, args },
    piReadonlySandboxInput({
      homeDir: home,
      tmpDir: privateTmp,
      policy: readonlyPolicy,
      env: effectiveFiles.env,
    }),
  );
  if (!launch.osSandboxed) {
    rmSync(privateTmp, { recursive: true, force: true });
    throw new DriverError("spawn_failed", READONLY_PI_NEEDS_SANDBOX_MESSAGE);
  }
  return {
    sessionId,
    effectiveFiles,
    launch,
    tmpDir: privateTmp,
    childEnv: {
      ...childEnv,
      TMPDIR: privateTmp,
      ...(process.platform === "win32" ? { TEMP: privateTmp, TMP: privateTmp } : {}),
    },
  };
}
