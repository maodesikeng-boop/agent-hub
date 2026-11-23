// Controls the always-on remote test computer over ssh. The key in the ssh alias is restricted on the remote side to
// one forced command (remote-command.sh), so these subcommands are the whole surface: no shell, no other files.
import type { InstanceControl } from "./bench.ts";

export type RemoteCommand =
  | { kind: "status" }
  | { kind: "start"; mode: "real" | "fake" }
  | { kind: "stop" }
  | { kind: "restart"; mode: "real" | "fake" }
  | { kind: "deploy"; commit: string }
  | { kind: "logs"; lines: number };

/**
 * Postcondition: the words sent as the ssh command, such as ["restart", "fake"].
 * Throws RangeError for a commit that is not 40 lowercase hex characters or a line count outside 1..2000,
 * so nothing a caller passes can reach the remote shell unchecked.
 */
export function remoteArgv(command: RemoteCommand): string[] {
  throw new Error("Not implemented");
}

/** Postcondition: an InstanceControl whose calls run `ssh <sshAlias> <remoteArgv>` and reject with the remote's stderr on a non-zero exit. */
export function createRemoteControl(options: { sshAlias: string; timeoutMs: number }): InstanceControl {
  throw new Error("Not implemented");
}
