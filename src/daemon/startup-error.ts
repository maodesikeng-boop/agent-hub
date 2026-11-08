// 启动失败时已知的几种原因：带一个 LOCAL_ERRORS 里的码，终端上只打表里的一句话 + hint（entry.ts 的 reportStartupFailure）。
import type { LocalErrorCode } from "../shared/errors.ts";

export class StartupError extends Error {
  readonly code: LocalErrorCode;
  /** 跟在表里那句话后面的具体信息（端口号、用户填的值），给人看的中文；可空。 */
  readonly detail: string;
  constructor(code: LocalErrorCode, detail = "", options?: ErrorOptions) {
    super(`${code}${detail === "" ? "" : `：${detail}`}`, options);
    this.name = "StartupError";
    this.code = code;
    this.detail = detail;
  }
}
