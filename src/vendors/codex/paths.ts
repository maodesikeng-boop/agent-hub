// codex 专属路径（docs/vendor-plugin-design.md 的 A7）。引了 node:path，只给守护进程用。
import { join } from "node:path";
import codex from "./spec.ts";

/**
 * codex 实际用的配置根目录：`CODEX_HOME`（去掉首尾空白后非空）优先，否则 `<主目录>/.codex`（spec 的 home.configHome）。
 * 认证判断、模型目录指纹（shared/paths.ts 的 vendorCatalogWatchFiles 按 configHome 通用地算）都用这条规则，保证看的是同一处。
 * 只剩守护进程的 daemon/vendors/codex.ts 在用；P3 它搬进这个文件夹后改用通用的那条，这个函数就删掉。
 */
export function codexHomeDir(env: Record<string, string | undefined>, userHome: string): string {
  const { rel, env: name } = codex.home.configHome!;
  return env[name]?.trim() || join(userHome, rel);
}
