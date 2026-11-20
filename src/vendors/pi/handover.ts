import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { agentLaunchArgs } from "../../shared/vendors.ts";
import { termGroupAfterExit } from "../../daemon/driver/process.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { ForkUnsupportedError, withoutHubEnv } from "../../daemon/handover/forker.ts";
import type { ForkHandle, ForkSource, ForkWriteResult, SessionForker } from "../../daemon/handover/forker.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { PI_NO_PROJECT_TRUST_ARGS, buildPiSkillArgs } from "./composer.ts";
import { runPiForkTurn } from "./fork-turn.ts";
import { isValidPiSessionId } from "./protocol.ts";
import { piSessionFiles, piTranscriptPath } from "./transcript.ts";

export const PI_NATIVE_FORKER_ID = "pi-native";

export interface PiForkerOptions {
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => ChildProcess;
  homeDir?: string;
  env?: Record<string, string | undefined>;
}

function buildPiForkArgs(src: ForkSource, forkId: string, forkTarget: string): string[] {
  const args: string[] = ["--mode", "rpc", "--fork", forkTarget, "--session-id", forkId];
  if (src.launch.promptFile.trim() !== "") {
    args.push("--append-system-prompt", src.launch.promptFile);
  }
  args.push(...PI_NO_PROJECT_TRUST_ARGS, ...buildPiSkillArgs(src.cwd, src.addDirs));
  if (src.launch.skillsDir) args.push("--skill", src.launch.skillsDir);
  args.push(...agentLaunchArgs({ vendor: src.vendor, model: src.model, effort: src.effort }));
  args.push("--exclude-tools", "edit,write,bash,powershell", "--no-mcp");
  return args;
}

export function createPiForker(options: PiForkerOptions = {}): SessionForker {
  const spawnProcess =
    options.spawnProcess ??
    ((command, args, opts) => {
      const spawned = spawnOwnedProcess(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const { child, detached } = spawned;
      trackChild(child, "handover:pi", { detached });
      return child;
    });

  return {
    id: PI_NATIVE_FORKER_ID,
    kind: "native",

    async fork(src: ForkSource, signal: AbortSignal): Promise<ForkHandle> {
      if (signal.aborted) throw new Error("复制被取消");
      if (!src.vendorSessionId.trim()) {
        throw new ForkUnsupportedError("原会话没有 pi 会话编号");
      }
      return {
        forkId: randomUUID(),
        extra: { cwd: src.cwd },
      };
    },

    async write(src: ForkSource, fork: ForkHandle, prompt: string, signal: AbortSignal): Promise<ForkWriteResult> {
      if (!src.vendorSessionId.trim()) {
        throw new ForkUnsupportedError("原会话没有 pi 会话编号");
      }
      if (signal.aborted) throw new Error("aborted");

      const cleanLaunch = withoutHubEnv(src.launch);
      const childEnv = buildChildEnv(options.env ?? process.env, cleanLaunch.env);

      const transcript = piTranscriptPath(
        { vendor: "pi", cwd: src.cwd, vendorSessionId: src.vendorSessionId },
        { home: options.homeDir, env: childEnv },
      );
      // Fork IDs must start alphanumeric so pi does not parse them as flags.
      if (transcript === null && !isValidPiSessionId(src.vendorSessionId)) {
        throw new ForkUnsupportedError(`pi 会话编号不合法：${src.vendorSessionId}`);
      }
      const forkTarget = transcript ?? src.vendorSessionId;
      const args = buildPiForkArgs(src, fork.forkId, forkTarget);
      const child = spawnProcess(src.executablePath, args, { cwd: src.cwd, env: childEnv });
      child.once("exit", () => termGroupAfterExit(child));

      return runPiForkTurn(child, src, fork, prompt, signal);
    },

    async remove(fork: ForkHandle): Promise<void> {
      const files = new Set<string>();
      if (typeof fork.extra?.sessionFile === "string" && fork.extra.sessionFile !== "") {
        files.add(fork.extra.sessionFile);
      }
      const cwd = fork.extra?.cwd ?? "";
      for (const f of piSessionFiles(
        { vendor: "pi", cwd, vendorSessionId: fork.forkId },
        { home: options.homeDir, env: options.env ?? process.env },
      )) {
        files.add(f);
      }
      await Promise.all([...files].map((file) => rm(file, { force: true })));
    },
  };
}

export const PI_FORKERS: readonly SessionForker[] = [createPiForker()];
