// 三家驱动测“性格设定、模式改了不重启”共用：一个真账本（内存库）里的项目经理，加上守护进程里同样接法的 personaNote
// （launch.ts 的 createPersonaNoter）。驱动层测试的会话编号和账本里的不一样，这里只认这一个项目经理的会话。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverOptions, PmMode, SessionId } from "../../shared/index.ts";
import { createLedger } from "../ledger/index.ts";
import { createPersonaNoter } from "../launch.ts";
import { openTestDb } from "../store/test-helpers.ts";

export interface PersonaFixture {
  /** 接到驱动层的 DriverOptions.personaNote。 */
  personaNote: NonNullable<DriverOptions["personaNote"]>;
  /** 现在拼提示词会记下的版本号（LaunchFiles.personaRevision）。 */
  revision(): number;
  /** 用户在资料页改。 */
  userEdit(input: { text?: string; mode?: PmMode }): void;
  /** 项目经理自己 hub persona edit。 */
  selfEdit(text: string): void;
  /** 资料页撤销最近一次。 */
  revert(): void;
  /** 资料页改模型（会重启）。 */
  userModel(model: string): void;
  cleanup(): void;
}

export function makePersonaFixture(): PersonaFixture {
  const db = openTestDb();
  const dataHome = mkdtempSync(join(tmpdir(), "agent-hub-persona-"));
  const ledger = createLedger(db, { pmHomeRoot: join(dataHome, "pm-home"), dataHome });
  const pm = ledger.createPm({ name: "小林", mode: "manage_only", persona: "小林的习惯" });
  const noter = createPersonaNoter((_id: SessionId, since) => ledger.personaUpdate(pm.sessionId, since));
  return {
    personaNote: (id, since) => noter(id, since),
    revision: () => ledger.getLaunchContext(pm.sessionId).pm.personaRevision ?? 0,
    userEdit: (input) => void ledger.editPersona(pm.pm.id, input, { kind: "user" }),
    selfEdit: (text) => void ledger.hubCall(pm.sessionId, "persona.edit", { text }),
    revert: () => {
      const id = ledger.getPersona(pm.pm.id).revertableChangeId;
      if (id === null) throw new Error("没有能撤销的修改");
      ledger.revertPersonaChange(id);
    },
    userModel: (model) => void ledger.editPersona(pm.pm.id, { model }, { kind: "user" }),
    cleanup: () => {
      db.close();
      rmSync(dataHome, { recursive: true, force: true });
    },
  };
}
