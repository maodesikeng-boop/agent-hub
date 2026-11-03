// 账本里的项目经理和性格设定：建项目经理（不含项目，见 ledger.ts 的 createPm）、看和改性格设定、撤销、
// 启动时同步性格设定文件（以数据库为准，见 syncPersonaFiles）。也放按编号找项目经理、项目经理的会话这些别处要用的读法。
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PM_MODES, PM_MODE_LABELS, isOneOf, normalizeName, personaOrTemplate, utf8Bytes } from "../../shared/domain.ts";
import type { AgentSessionRow, PersonaChange, PersonaChangeId, PmId, PmMode, SessionId } from "../../shared/domain.ts";
import type {
  CreatePmInput,
  CreatePmResult,
  EditPersonaInput,
  EditPersonaResult,
  LedgerActor,
  PersonaView,
  SyncPersonaFilesResult,
} from "../../shared/ledger.ts";
import { MAX_MODEL_CHARS, MAX_NAME_CHARS, MAX_PERSONA_BYTES, MAX_REASON_CHARS, PERSONA_CHANGES_LIMIT } from "../../shared/limits.ts";
import { personaFilePath } from "../../shared/paths.ts";
import { getAgentSession } from "../store/index.ts";
import { fail } from "./context.ts";
import type { LedgerContext, LedgerFiles, Pending } from "./context.ts";
import { contentHash } from "./files.ts";
import type { LedgerMessages } from "./messages.ts";
import { toConversation, toPersonaChange, toPm } from "./rows.ts";
import type { ConversationDbRow, PersonaChangeDbRow, PmDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

/** 性格设定的这次修改是谁做的（账本内部用）。 */
type PersonaEditor = { actor: "user" } | { actor: "file" } | { actor: "pm"; session: AgentSessionRow };

const BAD_NAME = `不能是空的、超过 ${MAX_NAME_CHARS} 个字，或带换行等控制字符`;

export type LedgerPersona = ReturnType<typeof createLedgerPersona>;


export function createLedgerPersona(ctx: LedgerContext, sessions: LedgerSessions, messages: LedgerMessages, files: LedgerFiles) {
  const { db, now, write } = ctx;
  const { insertSession } = sessions;
  const { insertSystemMessage } = messages;
  const { pmHomeRoot, personasDir, writeFile } = files;

  const pmRow = (id: PmId): PmDbRow | null => db.get<PmDbRow>("SELECT * FROM pms WHERE id = ?", id) ?? null;

  const requirePm = (id: PmId): PmDbRow => {
    const row = pmRow(id);
    if (row === null) throw fail("not_found", `没有编号 ${id} 的项目经理`);
    return row;
  };

  /** 项目经理的会话；不是（不存在、不是 pm、没有 pm_id）返回 null。 */
  const pmSession = (id: SessionId): (AgentSessionRow & { pmId: PmId }) | null => {
    const row = getAgentSession(db, id);
    return row !== null && row.role === "pm" && row.pmId !== null ? (row as AgentSessionRow & { pmId: PmId }) : null;
  };

  /** 项目经理唯一的那个对话（kind pm）。 */
  const privateConversation = (pmId: PmId): ConversationDbRow | null =>
    db.get<ConversationDbRow>("SELECT * FROM conversations WHERE kind = 'pm' AND pm_id = ? ORDER BY id LIMIT 1", pmId) ?? null;

  /**
   * 写性格设定文件（临时文件 + 改名），写成功才更新 persona_file_hash。没配 personasDir 什么也不做。
   * 写失败只记日志：数据库已经提交，下次启动 syncPersonaFiles 按数据库重写。
   */
  const persistPersonaFile = (pmId: PmId, text: string): boolean => {
    if (personasDir === undefined) return false;
    const file = personaFilePath(personasDir, pmId);
    try {
      writeFile(file, text);
    } catch (error) {
      console.error(`agent-hub: 写性格设定文件失败 ${file}:`, error);
      return false;
    }
    db.run("UPDATE pms SET persona_file = ?, persona_file_hash = ? WHERE id = ?", file, contentHash(text), pmId);
    return true;
  };

  const validName = (raw: string, what: string): string => {
    const name = typeof raw === "string" ? normalizeName(raw) : null;
    if (name === null) throw fail("invalid", `${what}名字不对：${BAD_NAME}`);
    return name;
  };

  const validPersonaText = (text: string) => {
    if (typeof text !== "string" || utf8Bytes(text) > MAX_PERSONA_BYTES) {
      throw fail("invalid", `性格设定太长，最多 ${MAX_PERSONA_BYTES / 1024} KB`);
    }
  };

  const validMode = (mode: unknown): PmMode => {
    if (!isOneOf(PM_MODES, mode)) throw fail("invalid", `模式只能是 ${PM_MODES.join(" 或 ")}`);
    return mode;
  };

  const getPersona = (pmId: PmId): PersonaView => {
    const pm = requirePm(pmId);
    const changes = db
      .all<PersonaChangeDbRow>("SELECT * FROM persona_changes WHERE pm_id = ? ORDER BY id DESC LIMIT ?", pmId, PERSONA_CHANGES_LIMIT)
      .map(toPersonaChange);
    return { pmId, text: personaOrTemplate(pm.persona), mode: pm.mode as PmMode, changes, revertableChangeId: changes[0]?.id ?? null };
  };

  /**
   * 改性格设定（editPersona、撤销、启动时发现手改都走这里），参数已经校验过。没变化（且不是撤销）返回 null。
   * 撤销哪怕内容一样也记一条（revertOf）。提交后写文件。
   */
  const editPersonaIn = (
    p: Pending,
    pm: PmDbRow,
    next: { text: string; mode: PmMode; reason: string | null },
    editor: PersonaEditor,
    revertOf: PersonaChangeId | null = null,
  ): PersonaChange | null => {
    const textBefore = personaOrTemplate(pm.persona);
    const modeBefore = pm.mode as PmMode;
    if (revertOf === null && next.text === textBefore && next.mode === modeBefore && pm.persona !== null) return null;
    const t = now();
    db.run("UPDATE pms SET persona = ?, mode = ? WHERE id = ?", next.text, next.mode, pm.id);
    const change = toPersonaChange(
      db.get<PersonaChangeDbRow>(
        `INSERT INTO persona_changes (pm_id, actor, session_id, text_before, text_after, mode_before, mode_after, reason, revert_of, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        pm.id,
        editor.actor,
        editor.actor === "pm" ? editor.session.id : null,
        textBefore,
        next.text,
        modeBefore,
        next.mode,
        next.reason,
        revertOf,
        t,
      )!,
    );
    p.changes.push({ type: "pm.updated", data: { pm: toPm(pmRow(pm.id)!) } });
    const modeNote = next.mode === modeBefore ? "" : `（模式：${PM_MODE_LABELS[modeBefore]} → ${PM_MODE_LABELS[next.mode]}）`;
    const reasonNote = next.reason === null ? "" : `。理由：${next.reason}`;
    let text: string;
    if (revertOf !== null) text = `已撤销${pm.name}的上一次性格设定修改${modeNote}`;
    else if (editor.actor === "pm") text = `${pm.name}改了自己的做事习惯${modeNote}${reasonNote}`;
    else if (editor.actor === "file") text = `发现${pm.name}的性格设定文件被手改过，已按文件更新`;
    else text = `你改了${pm.name}的性格设定${modeNote}${reasonNote}`;
    const conversationId = privateConversation(pm.id)?.id;
    if (conversationId !== undefined) {
      insertSystemMessage(p, conversationId, { event: "persona.changed", pmId: pm.id, personaChangeId: change.id, revertOf }, text);
    }
    p.after.push(() => persistPersonaFile(pm.id, next.text));
    return change;
  };

  /** 校验并改性格设定（editPersona、hub persona.edit），在调用方的事务里。 */
  const editPersonaChecked = (p: Pending, pmId: PmId, input: EditPersonaInput, editor: PersonaEditor): PersonaChange | null => {
    const pm = requirePm(pmId);
    if (input.text === undefined && input.mode === undefined) throw fail("invalid", "新的性格设定正文和模式至少给一个");
    if (input.text !== undefined) validPersonaText(input.text);
    const mode = input.mode === undefined ? (pm.mode as PmMode) : validMode(input.mode);
    const reason = input.reason?.trim() || null;
    if (reason !== null && [...reason].length > MAX_REASON_CHARS) throw fail("invalid", `理由最多 ${MAX_REASON_CHARS} 个字`);
    return editPersonaIn(p, pm, { text: input.text ?? personaOrTemplate(pm.persona), mode, reason }, editor);
  };

  const editPersona = (pmId: PmId, input: EditPersonaInput, actor: LedgerActor): EditPersonaResult => {
    let editor: PersonaEditor = { actor: "user" };
    if (actor.kind === "session") {
      const session = pmSession(actor.sessionId);
      if (session === null || session.pmId !== pmId) throw fail("forbidden", "只能改自己的性格设定");
      editor = { actor: "pm", session };
    }
    const change = write((p) => editPersonaChecked(p, pmId, input, editor));
    return { change, persona: getPersona(pmId) };
  };

  /** syncPersonaFiles 的一个项目经理。返回它进了哪张单子。 */
  const syncPersonaFile = (pm: PmDbRow): "recorded" | "rewritten" | null => {
    const file = personaFilePath(personasDir!, pm.id);
    let content: string | null;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      content = null;
    }
    // 1. M1 升上来的：文件在就按文件填，没有就用模板；不记修改
    if (pm.persona === null) {
      if (content !== null) {
        db.run("UPDATE pms SET persona = ?, persona_file = ?, persona_file_hash = ? WHERE id = ?", content, file, contentHash(content), pm.id);
        return null;
      }
      db.run("UPDATE pms SET persona = ? WHERE id = ?", personaOrTemplate(null), pm.id);
      persistPersonaFile(pm.id, personaOrTemplate(null));
      return "rewritten";
    }
    // 2. 文件不在或读不了
    if (content === null) {
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    const hash = contentHash(content);
    // 3. 没人动过文件：内容不一样说明上次没写成
    if (hash === pm.persona_file_hash) {
      if (content === pm.persona) return null;
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    // 4. 文件变过
    if (content === pm.persona) {
      db.run("UPDATE pms SET persona_file = ?, persona_file_hash = ? WHERE id = ?", file, hash, pm.id);
      return null;
    }
    if (pm.persona_file_hash === null) {
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    if (utf8Bytes(content) > MAX_PERSONA_BYTES) {
      console.error(`agent-hub: 手改的性格设定文件超过 ${MAX_PERSONA_BYTES} 字节，按数据库重写：${file}`);
      persistPersonaFile(pm.id, pm.persona);
      return "rewritten";
    }
    write((p) => editPersonaIn(p, pm, { text: content, mode: pm.mode as PmMode, reason: null }, { actor: "file" }));
    return "recorded";
  };

  /** 建项目经理、它唯一的对话和会话（cwd 是 pm-home/<编号>/），在调用方的事务里。项目另建（见 ledger.ts 的 createPm）。 */
  const createPmIn = (p: Pending, input: CreatePmInput): Omit<CreatePmResult, "project"> => {
    const name = validName(input.name, "项目经理");
    const mode = validMode(input.mode);
    validPersonaText(input.persona);
    const defaultModel = input.defaultModel?.trim() || null;
    if (defaultModel !== null && [...defaultModel].length > MAX_MODEL_CHARS) throw fail("invalid", `模型名最多 ${MAX_MODEL_CHARS} 个字`);
    if (db.get("SELECT 1 AS x FROM pms WHERE name = ?", name) !== undefined) {
      throw fail("conflict", `已经有一个叫“${name}”的项目经理了，换个名字`);
    }
    const t = now();
    const pmId = db.run(
      "INSERT INTO pms (name, mode, default_model, persona, created_at) VALUES (?, ?, ?, ?, ?)",
      name,
      mode,
      defaultModel,
      input.persona,
      t,
    ).lastInsertRowid;
    if (personasDir !== undefined) db.run("UPDATE pms SET persona_file = ? WHERE id = ?", personaFilePath(personasDir, pmId), pmId);
    const pm = toPm(pmRow(pmId)!);
    const conversationRow = db.get<ConversationDbRow>(
      "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('pm', ?, ?, ?) RETURNING *",
      pmId,
      name,
      t,
    )!;
    const cwd = join(pmHomeRoot, String(pmId));
    mkdirSync(cwd, { recursive: true });
    p.changes.push({ type: "pm.created", data: { pm } });
    const conversation = toConversation(conversationRow);
    p.changes.push({ type: "conversation.created", data: { conversation } });
    const session = insertSession(p, { conversationId: conversation.id, pmId, cwd, addDirs: [], generation: 1, model: defaultModel });
    p.after.push(() => persistPersonaFile(pmId, input.persona));
    return { pm, conversation, sessionId: session.id };
  };

  const revertPersonaChange = (changeId: PersonaChangeId): EditPersonaResult => {
    const row = db.get<PersonaChangeDbRow>("SELECT * FROM persona_changes WHERE id = ?", changeId);
    if (row === undefined) throw fail("not_found", `没有编号 ${changeId} 的修改记录`);
    const change = write((p) => {
      const latest = db.get<{ id: number }>("SELECT id FROM persona_changes WHERE pm_id = ? ORDER BY id DESC LIMIT 1", row.pm_id)!;
      if (latest.id !== row.id) throw fail("conflict", "只能撤销最近一次修改");
      return editPersonaIn(
        p,
        pmRow(row.pm_id)!,
        { text: row.text_before, mode: row.mode_before as PmMode, reason: null },
        { actor: "user" },
        row.id,
      );
    });
    return { change, persona: getPersona(row.pm_id) };
  };

  const syncPersonaFiles = (): SyncPersonaFilesResult => {
    const result: SyncPersonaFilesResult = { recordedPmIds: [], rewrittenPmIds: [] };
    if (personasDir === undefined) return result;
    for (const pm of db.all<PmDbRow>("SELECT * FROM pms ORDER BY id")) {
      const outcome = syncPersonaFile(pm);
      if (outcome === "recorded") result.recordedPmIds.push(pm.id);
      else if (outcome === "rewritten") result.rewrittenPmIds.push(pm.id);
    }
    return result;
  };

  return {
    pmRow,
    requirePm,
    pmSession,
    privateConversation,
    validName,
    getPersona,
    editPersonaChecked,
    editPersona,
    createPmIn,
    revertPersonaChange,
    syncPersonaFiles,
  };
}
