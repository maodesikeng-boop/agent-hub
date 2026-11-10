// 各厂商复制会话的办法清单（docs/background-handover-design.md 第 7 节）。每家的清单在自己的 src/vendors/<厂商>/daemon.ts 的 forkers，
// 这里按名单推出来（docs/vendor-plugin-design.md 的 B7）；daemon.ts 没写 forkers 的厂商是 []，只能本会话写交接。
import { AGENT_VENDORS } from "../../shared/vendors.ts";
import { VENDOR_DAEMONS } from "../../vendors/daemon-registry.ts";
import type { ForkerRegistry } from "./forker.ts";

export const FORKERS: ForkerRegistry = Object.fromEntries(AGENT_VENDORS.map((vendor) => [vendor, VENDOR_DAEMONS[vendor].forkers ?? []])) as ForkerRegistry;
