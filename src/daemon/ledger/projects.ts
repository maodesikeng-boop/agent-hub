// 账本里的项目：建项目（连同项目群和第一代会话）、挂和移除文件夹、交接（换项目经理，走 sessions.ts 的 nextGeneration）。
import { rmSync } from "node:fs";
import { normalizeName, utf8Bytes } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, ProjectFolder, ProjectId, SessionId, SystemMessageMeta } from "../../shared/domain.ts";
import type { HubArgs, HubResult, ProjectCard } from "../../shared/hub.ts";
import type { CreateProjectInput, CreateProjectResult, LedgerActor } from "../../shared/ledger.ts";
import { MAX_DESCRIPTION_CHARS, MAX_HANDOFF_BYTES } from "../../shared/limits.ts";
import { handoffFilePath } from "../../shared/paths.ts";
import { fail } from "./context.ts";
import type { LedgerContext, LedgerFiles, Pending } from "./context.ts";
import { realpathOrLiteral } from "./files.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toConversation, toHandoff, toProject, toProjectFolder } from "./rows.ts";
import type { ConversationDbRow, HandoffDbRow, PmDbRow, ProjectDbRow, ProjectFolderDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";

export type LedgerProjects = ReturnType<typeof createLedgerProjects>;


export function createLedgerProjects(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  files: LedgerFiles,
) {
  const { db, now, write } = ctx;
  const { currentSession, insertSession, nextGeneration } = sessions;
  const { insertSystemMessage } = messages;
  const { pmRow, requirePm, pmSession, privateConversation, validName } = persona;
  const { userHome, resolveFolder, handoffsDir, writeFile } = files;

  const projectRow = (id: ProjectId): ProjectDbRow => db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", id)!;

  const activeProjectByName = (name: string): ProjectDbRow | null => {
    const normalized = normalizeName(name);
    if (normalized === null) return null;
    return db.get<ProjectDbRow>("SELECT * FROM projects WHERE name = ? AND status = 'active'", normalized) ?? null;
  };

  /** 按名字找进行中的项目，并确认是这个项目经理现在管的。 */
  const managedProject = (pmId: PmId, name: string): ProjectDbRow => {
    const row = activeProjectByName(name);
    if (row === null) throw fail("not_found", `没有叫“${name}”的项目`);
    if (row.pm_id !== pmId) throw fail("forbidden", `项目“${row.name}”不归你管，只能操作自己管的项目`);
    return row;
  };

  /** 没移除的文件夹，按编号排。 */
  const foldersOf = (projectId: ProjectId): ProjectFolder[] =>
    db
      .all<ProjectFolderDbRow>("SELECT * FROM project_folders WHERE project_id = ? AND removed_at IS NULL ORDER BY id", projectId)
      .map(toProjectFolder);

  const projectCard = (row: ProjectDbRow): ProjectCard => {
    const folders = foldersOf(row.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      mainFolder: folders.find((f) => f.isMain)?.path ?? "",
      otherFolders: folders.filter((f) => !f.isMain).map((f) => f.path),
    };
  };

  const managedProjects = (pmId: PmId): ProjectDbRow[] =>
    db.all<ProjectDbRow>("SELECT * FROM projects WHERE pm_id = ? AND status = 'active' ORDER BY id", pmId);

  /** 群最新一代会话的 addDirs 跟着项目的附加文件夹走，推 folders.updated。 */
  const foldersChanged = (p: Pending, project: ProjectDbRow): ProjectFolder[] => {
    const folders = foldersOf(project.id);
    const latest = currentSession(project.conversation_id);
    if (latest !== null) {
      db.run(
        "UPDATE agent_sessions SET add_dirs = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(folders.filter((f) => !f.isMain).map((f) => f.path)),
        now(),
        latest.id,
      );
    }
    p.changes.push({ type: "folders.updated", data: { projectId: project.id, folders } });
    return folders;
  };

  const createProjectIn = (p: Pending, input: CreateProjectInput): CreateProjectResult => {
    const name = validName(input.name, "项目");
    const description = typeof input.description === "string" ? input.description.trim() || null : null;
    if (description !== null && [...description].length > MAX_DESCRIPTION_CHARS) {
      throw fail("invalid", `项目说明最多 ${MAX_DESCRIPTION_CHARS} 个字`);
    }
    const pm = requirePm(input.pmId);
    if (activeProjectByName(name) !== null) throw fail("conflict", `已经有一个叫“${name}”的项目了，换个名字`);
    const path = resolveFolder(input.folder);
    const owner = db.get<{ name: string }>(
      `SELECT p.name FROM project_folders f JOIN projects p ON p.id = f.project_id
       WHERE f.path = ? AND f.is_main = 1 AND f.removed_at IS NULL`,
      path,
    );
    if (owner !== undefined) throw fail("conflict", `这个文件夹已经是项目“${owner.name}”的主文件夹：${path}`);
    const t = now();
    const conversationId = db.run(
      "INSERT INTO conversations (kind, pm_id, title, created_at) VALUES ('project_group', ?, ?, ?)",
      pm.id,
      name,
      t,
    ).lastInsertRowid;
    const projectId = db.run(
      "INSERT INTO projects (name, description, status, pm_id, conversation_id, created_at, updated_at) VALUES (?, ?, 'active', ?, ?, ?, ?)",
      name,
      description,
      pm.id,
      conversationId,
      t,
      t,
    ).lastInsertRowid;
    db.run("UPDATE conversations SET project_id = ? WHERE id = ?", projectId, conversationId);
    const mainFolder = toProjectFolder(
      db.get<ProjectFolderDbRow>(
        "INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (?, ?, 1, ?) RETURNING *",
        projectId,
        path,
        t,
      )!,
    );
    const project = toProject(projectRow(projectId));
    const conversation = toConversation(db.get<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", conversationId)!);
    p.changes.push({ type: "project.created", data: { project } });
    p.changes.push({ type: "conversation.created", data: { conversation } });
    const session = insertSession(p, { conversationId, pmId: pm.id, cwd: path, addDirs: [], generation: 1, model: pm.default_model });
    p.changes.push({ type: "folders.updated", data: { projectId, folders: [mainFolder] } });
    insertSystemMessage(p, conversationId, { event: "project.created", projectId }, `项目已建好：${name}，主文件夹 ${path}，项目经理 ${pm.name}`);
    return { project, mainFolder, conversation, sessionId: session.id };
  };

  /** 系统消息要不要同时发给群里的 agent：调用者就是群最新一代自己就不发（见 SystemMessageMeta）。 */
  const folderNoticeTarget = (caller: AgentSessionRow, project: ProjectDbRow): SessionId | null => {
    const latest = currentSession(project.conversation_id);
    return latest === null || latest.id === caller.id ? null : latest.id;
  };

  const attachIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.attach">): HubResult<"project.attach"> => {
    const project = managedProject(caller.pmId, args.project);
    const path = resolveFolder(args.folder);
    if (db.get("SELECT 1 AS x FROM project_folders WHERE project_id = ? AND path = ? AND removed_at IS NULL", project.id, path) !== undefined) {
      throw fail("conflict", `这个文件夹已经挂在项目“${project.name}”上了：${path}`);
    }
    const folder = toProjectFolder(
      db.get<ProjectFolderDbRow>(
        "INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (?, ?, 0, ?) RETURNING *",
        project.id,
        path,
        now(),
      )!,
    );
    foldersChanged(p, project);
    insertSystemMessage(
      p,
      project.conversation_id,
      { event: "folder.attached", projectId: project.id, folderId: folder.id, path },
      `已挂上文件夹：${path}（下一条消息起生效）`,
      folderNoticeTarget(caller, project),
    );
    return { text: `已把 ${path} 挂到项目“${project.name}”上，群里下一条消息起能用。`, data: { project: toProject(project), folder } };
  };

  const detachIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.detach">): HubResult<"project.detach"> => {
    const project = managedProject(caller.pmId, args.project);
    const path = realpathOrLiteral(args.folder, userHome);
    const row = db.get<ProjectFolderDbRow>(
      "SELECT * FROM project_folders WHERE project_id = ? AND path = ? AND removed_at IS NULL",
      project.id,
      path,
    );
    if (row === undefined) throw fail("not_found", `项目“${project.name}”上没有挂这个文件夹：${path}`);
    if (row.is_main === 1) throw fail("invalid", `主文件夹不能移除：${path}`);
    db.run("UPDATE project_folders SET removed_at = ? WHERE id = ?", now(), row.id);
    const folder = toProjectFolder(db.get<ProjectFolderDbRow>("SELECT * FROM project_folders WHERE id = ?", row.id)!);
    foldersChanged(p, project);
    insertSystemMessage(
      p,
      project.conversation_id,
      { event: "folder.detached", projectId: project.id, folderId: folder.id, path },
      `已移除文件夹：${path}（只是不再挂在项目上，磁盘上的文件没动；下一条消息起生效）`,
      folderNoticeTarget(caller, project),
    );
    return { text: `已把 ${path} 从项目“${project.name}”上移除。`, data: { project: toProject(project), folder } };
  };

  const assignIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.assign">): HubResult<"project.assign"> => {
    const project = managedProject(caller.pmId, args.project);
    const handoffText = typeof args.handoff === "string" ? args.handoff : "";
    if (handoffText.trim() === "") throw fail("invalid", "交接正文不能是空的：先写清楚交接再换人");
    if (utf8Bytes(handoffText) > MAX_HANDOFF_BYTES) throw fail("invalid", `交接正文太长，最多 ${MAX_HANDOFF_BYTES / 1024} KB`);
    const toName = normalizeName(args.to);
    const from = pmRow(caller.pmId)!;
    if (toName !== null && toName === from.name) throw fail("invalid", "不能交给自己");
    const to = toName === null ? undefined : db.get<PmDbRow>("SELECT * FROM pms WHERE name = ?", toName);
    if (to === undefined) throw fail("not_found", `没有叫“${args.to}”的项目经理（hub pm list 可以看有哪些）`);
    if (handoffsDir === undefined) throw new Error("ledger: handoffsDir is not configured");
    const t = now();
    const { old, next } = nextGeneration(p, project.conversation_id, { pmId: to.id, model: to.default_model });
    // 文件名要带交接编号，所以先插一行（file 先空着），拿到编号再定文件名、写文件、回填
    const inserted = db.get<HandoffDbRow>(
      `INSERT INTO handoffs (project_id, from_session_id, to_session_id, from_pm_id, to_pm_id, file, reason, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'reassign', ?) RETURNING *`,
      project.id,
      old.id,
      next.id,
      from.id,
      to.id,
      t,
    )!;
    const file = handoffFilePath(handoffsDir, project.id, inserted.id, t);
    writeFile(file, handoffText);
    p.undo.push(() => rmSync(file, { force: true }));
    const handoff = toHandoff(db.get<HandoffDbRow>("UPDATE handoffs SET file = ? WHERE id = ? RETURNING *", file, inserted.id)!);
    db.run("UPDATE projects SET pm_id = ?, updated_at = ? WHERE id = ?", to.id, t, project.id);
    const updated = toProject(projectRow(project.id));
    p.changes.push({ type: "project.updated", data: { project: updated } });
    const meta: SystemMessageMeta = { event: "project.reassigned", projectId: project.id, handoffId: handoff.id, fromPmId: from.id, toPmId: to.id };
    insertSystemMessage(p, project.conversation_id, meta, `项目经理由${from.name}换成${to.name}，交接在这里：${file}`);
    const toPrivate = privateConversation(to.id);
    if (toPrivate !== null) {
      const target = currentSession(toPrivate.id);
      insertSystemMessage(
        p,
        toPrivate.id,
        meta,
        `${from.name}把 ${project.name} 交给了你，以后 ${project.name} 群里由你回复。交接正文在 ${file}，群里的会话启动时也会带上。`,
        target?.id ?? null,
      );
    }
    return {
      text: `已把项目“${project.name}”交给${to.name}，交接已存好。群里之后由${to.name}回复；群里原来的会话回完这一轮就结束。`,
      data: { project: updated, handoff, sessionId: next.id },
    };
  };

  const createProject = (input: CreateProjectInput, actor: LedgerActor): CreateProjectResult => {
    if (actor.kind === "session") {
      const session = pmSession(actor.sessionId);
      if (session === null || session.pmId !== input.pmId) throw fail("forbidden", "只能给自己建项目");
    }
    return write((p) => createProjectIn(p, input));
  };

  return { projectRow, managedProjects, projectCard, createProjectIn, attachIn, detachIn, assignIn, createProject };
}
