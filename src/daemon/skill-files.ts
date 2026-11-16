// 技能文件在磁盘上的那一半（docs/skill-carryover-design.md）：枚举技能目录建已知技能名单、把工具参数里的路径规整成真实路径、换代时读正文。
// 账本（ledger/loaded-skills.ts）只认 shared/skill-loads.ts 给的信号，碰磁盘的都在这里。只读名单里的文件，从模型写的文本里拼出来的路径一律不打开。
// 技能目录不另起一张表：会话启动目录里的产品技能（task-graph-skill.ts），加上各家 vendor-sync 已经声明的项目、全局技能目录（VendorSyncAdapter.skillTarget）。
import type { AgentSessionRow } from "../shared/domain.ts";
import type { KnownSkill, SkillCatalog } from "../shared/skill-loads.ts";
import type { VendorSyncContext } from "../vendors/daemon-types.ts";

/** 认技能用到的会话信息。 */
export type SkillSession = Pick<AgentSessionRow, "id" | "vendor" | "cwd" | "addDirs">;

export interface SkillFiles {
  /** 这个会话的已知技能名单（按会话缓存 SKILL_CATALOG_TTL_MS）；fresh 不用缓存、现枚举（换代时）。 */
  catalog(session: SkillSession, options?: { fresh?: boolean }): SkillCatalog;
  /** 换代时读正文：只读名单里的文件，读之前再核一次真实路径没变；读不到是 null。 */
  read(skill: KnownSkill): string | null;
}

export function createSkillFiles(options: { launchDir?: string; userHome: string; env?: VendorSyncContext["env"] }): SkillFiles {
  throw new Error(`未实现 ${options.userHome}`);
}
