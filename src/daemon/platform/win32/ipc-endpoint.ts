import { randomBytes } from "node:crypto";
import { dataDirPipeHash, isWindowsNamedPipe } from "../../../shared/paths.ts";

export { dataDirPipeHash, isWindowsNamedPipe };

/** Creates a unique Windows control pipe name for `fusa-run.exe --ctrl-pipe`. */
export function createWin32ControlPipeName(pid: number = process.pid): string {
  return `\\\\.\\pipe\\fusa-ctrl-${pid}-${randomBytes(8).toString("hex")}`;
}
