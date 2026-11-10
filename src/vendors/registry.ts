// 厂商名单（docs/vendor-plugin-design.md 3.4 节）：加一家厂商只改这里——import 它的 spec.ts，在 VENDOR_LIST 里加一项。
// AGENT_VENDORS、VENDOR_SPECS、VENDOR_HOME_PATHS、VENDOR_FAILURE_SIGNS 都从这里推出来（src/shared/vendors.ts）；守护进程侧按这份名单加载各家的
// daemon.ts、paths.ts（daemon-registry.ts、shared/paths.ts），推出 DAEMON_VENDORS、FORKERS、VENDOR_FALLBACK_PATHS 等。
import agy from "./agy/spec.ts";
import claude from "./claude/spec.ts";
import codex from "./codex/spec.ts";
import cursor from "./cursor/spec.ts";
import pi from "./pi/spec.ts";

/** 顺序 = 下拉、额度面板里的顺序；第一个是默认厂商。 */
export const VENDOR_LIST = [claude, agy, codex, pi, cursor] as const;

/** 厂商编号（agent_sessions.vendor、pms.vendor 存的就是它）。 */
export type AgentVendor = (typeof VENDOR_LIST)[number]["id"];
