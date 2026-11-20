import type { AgentSessionRow } from "../../shared/domain.ts";
import { ensurePmMemoryDir } from "../pm-memory.ts";

export function withPmMemoryAddDir(row: AgentSessionRow, pmMemoryDir: string | undefined): AgentSessionRow {
  if (!pmMemoryDir || row.role !== "pm" || row.pmId === null) return row;
  const dir = ensurePmMemoryDir(pmMemoryDir, row.pmId);
  if (row.addDirs.includes(dir)) return row;
  return { ...row, addDirs: [...row.addDirs, dir] };
}
