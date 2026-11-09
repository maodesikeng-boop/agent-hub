// Claude Code 的模型名单和登录状态（docs/vendor-availability-design.md 第 3 节）。单独一个文件：claude.ts 给账本用，
// 不能引入起进程的代码（claude.test.ts 查），起进程问名单的在这里。
import { vendorCatalogFingerprint } from "../../shared/paths.ts";
import { parseInitializeModels, queryClaudeAuthStatus, queryClaudeInitialize, type VendorCatalogSource } from "../driver/model-catalog.ts";
import type { VendorCatalogProbe, VendorCatalogSourceOptions } from "./types.ts";

/** initialize 回应里的 account 有身份信息（实测有 email、organization）就是登录了；没有说不清，交给 claude auth status。 */
export const claudeCatalogProbe: VendorCatalogProbe = {
  parse: (raw) => parseInitializeModels((raw as { models?: unknown } | null)?.models),
  availabilityOf(raw) {
    const account = (raw as { account?: { email?: unknown; organization?: unknown } } | null)?.account;
    // 只认身份字段：没登录时 account 里可能也有 apiProvider 这类和登录无关的
    const identity = [account?.email, account?.organization].some((v) => typeof v === "string" && v.trim() !== "");
    return identity ? "available" : "unknown";
  },
};

/** 名单那次查询：发 initialize 拿整个回应（models 和 account 一起），看不出登录时才另跑 `claude auth status`。 */
export function createClaudeCatalogSource(options: VendorCatalogSourceOptions): VendorCatalogSource {
  const query = { claudePath: options.path, cwd: options.cwd, ...(options.env ? { env: options.env } : {}) };
  return {
    ...claudeCatalogProbe,
    query: (signal) => queryClaudeInitialize({ ...query, signal }),
    confirm: (signal) => queryClaudeAuthStatus({ ...query, signal }),
    installed: options.installed,
    fingerprint: options.fingerprint ?? (() => vendorCatalogFingerprint("claude", options.path, options.env ?? process.env, options.cwd)),
  };
}
