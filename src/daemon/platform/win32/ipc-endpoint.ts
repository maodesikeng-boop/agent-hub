import { randomBytes } from "node:crypto";
import { dataDirPipeHash, isWindowsNamedPipe } from "../../../shared/paths.ts";

export { dataDirPipeHash, isWindowsNamedPipe };

export function createWin32ControlPipeName(pid: number = process.pid): string {
  return `\\\\.\\pipe\\fusa-ctrl-${pid}-${randomBytes(8).toString("hex")}`;
}
