import type { AgentSessionRow } from "../../shared/domain.ts";
import { ensurePmMemoryDir } from "../pm-memory.ts";

/**
 * 为项目经理会话统一追加专属可读写记忆目录 `<pmMemoryDir>/<pmId>`（realpath 后去重）；
 * 普通 Worker（含 worktree 与主文件夹）与 assistant 会话原样返回，绝不挂载 `state/pm-memory`。
 */
export function withPmMemoryAddDir(row: AgentSessionRow, pmMemoryDir: string | undefined): AgentSessionRow {
  if (!pmMemoryDir || row.role !== "pm" || row.pmId === null) return row;
  const dir = ensurePmMemoryDir(pmMemoryDir, row.pmId);
  if (row.addDirs.includes(dir)) return row;
  return { ...row, addDirs: [...row.addDirs, dir] };
}
