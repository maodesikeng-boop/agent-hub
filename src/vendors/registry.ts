// 厂商名单（docs/vendor-plugin-design.md 3.4 节）：加一家厂商只改这里——import 它的 spec.ts，在 VENDOR_LIST 里加一项。
// AGENT_VENDORS、VENDOR_SPECS、VENDOR_HOME_PATHS、VENDOR_FAILURE_SIGNS、VENDOR_FALLBACK_PATHS 都从这里推出来（src/shared/vendors.ts、paths.ts）。
import agy from "./agy/spec.ts";
import claude from "./claude/spec.ts";
import codex from "./codex/spec.ts";

/** 顺序 = 下拉、额度面板里的顺序；第一个是默认厂商。 */
export const VENDOR_LIST = [claude, agy, codex] as const;

/** 厂商编号（agent_sessions.vendor、pms.vendor 存的就是它）。 */
export type AgentVendor = (typeof VENDOR_LIST)[number]["id"];
