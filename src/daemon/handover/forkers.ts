// 各厂商复制会话的办法清单（docs/background-handover-design.md 第 7 节）。每家的清单在自己的文件里（claude.ts 等），这里只登记。
// 接新厂商：shared/vendors.ts 的 AGENT_VENDORS 加上它，这里就编译不过，逼着填；CLI 没有复制会话的能力就填 []。
import { AGY_FORKERS } from "./agy.ts";
import { CLAUDE_FORKERS } from "./claude.ts";
import { CODEX_FORKERS } from "./codex.ts";
import type { ForkerRegistry } from "./forker.ts";

export const FORKERS: ForkerRegistry = {
  claude: CLAUDE_FORKERS,
  codex: CODEX_FORKERS,
  agy: AGY_FORKERS,
};
