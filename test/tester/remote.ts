// Controls the always-on remote test computer over ssh. The key in the ssh alias is restricted on the remote side to
// one forced command (remote-command.sh), so these subcommands are the whole surface: no shell, no other files.
import { spawn } from "node:child_process";
import type { InstanceControl } from "./bench.ts";
import { TESTER_REMOTE_LOG_MAX_LINES } from "./limits.ts";

export type RemoteCommand =
  | { kind: "status"; detail?: "presence" | "router-chats" }
  | { kind: "start"; mode: "real" | "fake" }
  | { kind: "stop" }
  | { kind: "restart"; mode: "real" | "fake" }
  | { kind: "deploy"; commit: string }
  | { kind: "logs"; lines: number };

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Postcondition: the words sent as the ssh command, such as ["restart", "fake"].
 * Throws RangeError for a commit that is not 40 lowercase hex characters or a line count outside 1..2000,
 * so nothing a caller passes can reach the remote shell unchecked.
 */
export function remoteArgv(command: RemoteCommand): string[] {
  switch (command.kind) {
    case "status":
      return command.detail === "presence" || command.detail === "router-chats" ? ["status", command.detail] : ["status"];
    case "stop":
      return [command.kind];
    case "start":
    case "restart":
      if (command.mode !== "real" && command.mode !== "fake") throw new RangeError(`unknown mode ${String(command.mode)}`);
      return [command.kind, command.mode];
    case "deploy":
      if (!COMMIT.test(command.commit)) throw new RangeError(`deploy needs a 40-character lowercase hex commit: ${command.commit}`);
      return ["deploy", command.commit];
    case "logs":
      if (!Number.isInteger(command.lines) || command.lines < 1 || command.lines > TESTER_REMOTE_LOG_MAX_LINES) throw new RangeError(`logs needs 1..${TESTER_REMOTE_LOG_MAX_LINES} lines: ${command.lines}`);
      return ["logs", String(command.lines)];
  }
}

export interface RemoteControl extends InstanceControl {
  /** Postcondition: the forced command's status output, such as the service state and the deployed commit. */
  status(): Promise<string>;
  presence(): Promise<string>;
  routerChats(): Promise<string>;
}

export type SshSpawn = typeof spawn;

/** Postcondition: an InstanceControl whose calls run `ssh <sshAlias> <remoteArgv>` and reject with the remote's stderr on a non-zero exit. */
export function createRemoteControl(options: { sshAlias: string; timeoutMs: number; spawn?: SshSpawn }): RemoteControl {
  const doSpawn = options.spawn ?? spawn;
  const run = (command: RemoteCommand): Promise<string> =>
    new Promise((resolve, reject) => {
      const argv = remoteArgv(command);
      const child = doSpawn("ssh", ["-o", "BatchMode=yes", "-T", options.sshAlias, ...argv], { stdio: ["ignore", "pipe", "pipe"], shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`ssh ${options.sshAlias} ${argv.join(" ")} timed out after ${options.timeoutMs / 1000} s`));
      }, options.timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`ssh ${options.sshAlias} ${argv.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
    });
  return {
    status: () => run({ kind: "status" }),
    presence: () => run({ kind: "status", detail: "presence" }),
    routerChats: () => run({ kind: "status", detail: "router-chats" }),
    start: async (mode) => void (await run({ kind: "start", mode })),
    stop: async () => void (await run({ kind: "stop" })),
    restart: async (mode) => void (await run({ kind: "restart", mode })),
    deploy: async (commit) => void (await run({ kind: "deploy", commit })),
    logs: (lines) => run({ kind: "logs", lines }),
  };
}
