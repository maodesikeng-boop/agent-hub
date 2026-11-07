// codex 复制会话去后台写交接的办法（docs/background-handover-design.md 第 2.3、2.6 节）。PR 0 只占位：清单空 = 只能本会话写交接。
import type { SessionForker } from "./forker.ts";

export const CODEX_FORKERS: readonly SessionForker[] = [];
