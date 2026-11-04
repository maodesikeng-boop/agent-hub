// 启动文件的指纹（W3 的 prepareLaunch 用，见 driver.ts 的 LaunchFiles.fingerprint）。用到 node:crypto，
// 只给守护进程和测试用，不在 index.ts 里导出。
import { createHash } from "node:crypto";

/**
 * 这一次启动要写的两份内容。只放真正写进文件的内容：不能有时间、随机数、令牌（令牌在 env 里，不进文件），
 * 否则每次算出来都不一样，驱动层会每轮都重启。
 */
export interface LaunchContents {
  prompt: string;
  /** --settings 文件的内容；没有设置文件是 null。 */
  settings: string | null;
}

/** sha256 十六进制。两段先按 JSON 数组编码再算，内容挪到另一段算不一样。同样的输入一定得到同样的结果。 */
export function launchFingerprint(contents: LaunchContents): string {
  return createHash("sha256")
    .update(JSON.stringify([contents.prompt, contents.settings]))
    .digest("hex");
}
