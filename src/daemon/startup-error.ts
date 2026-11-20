import type { LocalErrorCode } from "../shared/errors.ts";

export class StartupError extends Error {
  readonly code: LocalErrorCode;
  readonly detail: string;
  constructor(code: LocalErrorCode, detail = "", options?: ErrorOptions) {
    super(`${code}${detail === "" ? "" : `：${detail}`}`, options);
    this.name = "StartupError";
    this.code = code;
    this.detail = detail;
  }
}
