import { randomBytes } from "node:crypto";
import { isWindowsNamedPipe } from "../../../shared/paths.ts";

export { isWindowsNamedPipe };

export function createWin32ControlPipeName(pid: number = process.pid): string {
  return `\\\\.\\pipe\\fusa-ctrl-${pid}-${randomBytes(8).toString("hex")}`;
}
