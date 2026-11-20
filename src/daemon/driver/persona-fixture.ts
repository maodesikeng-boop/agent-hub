import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverOptions, PmMode, SessionId } from "../../shared/index.ts";
import { createLedger } from "../ledger/index.ts";
import { createPersonaNoter } from "../launch.ts";
import { openTestDb } from "../store/test-helpers.ts";

export interface PersonaFixture {
  personaNote: NonNullable<DriverOptions["personaNote"]>;
  revision(): number;
  userEdit(input: { text?: string; mode?: PmMode }): void;
  selfEdit(text: string): void;
  revert(): void;
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
