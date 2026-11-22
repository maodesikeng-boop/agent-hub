import { existsSync } from "node:fs";
import { basename } from "node:path";
import { normalizeName, utf8Bytes } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, Project, ProjectFolder, ProjectId } from "../../shared/domain.ts";
import type { HubArgs, HubResult, ProjectCard } from "../../shared/hub.ts";
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_REVIEW_STATUS_ACCOUNT_CHARS, MAX_SETUP_COMMAND_BYTES } from "../../shared/limits.ts";
import { projectWorktreesDir } from "../../shared/paths.ts";
import { fail } from "./context.ts";
import type { LedgerContext, LedgerFiles, Pending } from "./context.ts";
import { realpathOrLiteral } from "./files.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import { toProject, toProjectFolder } from "./rows.ts";
import type { ProjectDbRow, ProjectFolderDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { normalizePathForComparison } from "../platform/index.ts";

export type LedgerProjects = ReturnType<typeof createLedgerProjects>;

export interface CreateProjectInput {
  pmId: PmId;
  folder: string;
  name?: string;
  description?: string;
}

const ONE_PROJECT_PER_PM = "一个项目经理只管一个项目，请新建一个项目经理";

export const DEFAULT_PROJECT_NAME = "未命名项目";

function defaultProjectName(path: string): string {
  return normalizeName([...basename(path).trim()].slice(0, MAX_NAME_CHARS).join("")) ?? DEFAULT_PROJECT_NAME;
}

function validSetupCommand(command: unknown): string | null {
  if (command === null) return null;
  if (typeof command !== "string" || command.trim() === "") {
    throw fail("invalid", `准备命令不能是空的；要清除用 ${HUB_COMMAND} project setup --clear`);
  }
  if (command.includes("\0")) throw fail("invalid", "准备命令里不能有 NUL 字符");
  if (utf8Bytes(command) > MAX_SETUP_COMMAND_BYTES) throw fail("invalid", `准备命令不能超过 ${MAX_SETUP_COMMAND_BYTES} 字节`);
  return command;
}

// Enterprise Managed Users logins carry an underscore suffix, so `_` is allowed alongside GitHub's letters, digits, and single hyphens.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_]|-(?=[A-Za-z0-9_]))*$/u;

/**
 * Validates the `hub project review-status --account` value: a GitHub login up to
 * `MAX_REVIEW_STATUS_ACCOUNT_CHARS`, or null to clear. Throws `invalid` for anything else, including values shaped like tokens.
 */
export function validReviewStatusAccount(raw: unknown): string | null {
  if (raw === null) return null;
  const usage = `${HUB_COMMAND} project review-status --account <登录名>`;
  if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid", `账号不能是空的；要清除用 ${HUB_COMMAND} project review-status --clear`);
  if (raw.length > MAX_REVIEW_STATUS_ACCOUNT_CHARS) throw fail("invalid", `账号不能超过 ${MAX_REVIEW_STATUS_ACCOUNT_CHARS} 个字符`);
  if (/^(?:gh[pousr]_|github_pat_)/u.test(raw)) throw fail("invalid", `这里只填登录名，不要填令牌：${usage}`);
  if (!GITHUB_LOGIN.test(raw)) throw fail("invalid", `账号只能是 gh 里登录的用户名（字母、数字、单个连字符或下划线）：${usage}`);
  return raw;
}

export const reviewStatusAccountOf = (db: LedgerContext["db"], projectId: ProjectId): string | null =>
  db.get<{ account: string }>("SELECT account FROM project_review_status WHERE project_id = ?", projectId)?.account ?? null;

function writeSetupCommandIn(ctx: LedgerContext, p: Pending, projectId: ProjectId, command: string | null): ProjectDbRow {
  ctx.db.run("UPDATE projects SET setup_command = ?, updated_at = ? WHERE id = ?", command, ctx.now(), projectId);
  const row = ctx.db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", projectId)!;
  p.changes.push({ type: "project.updated", data: { project: toProject(row) } });
  return row;
}

export function createLedgerProjects(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  files: LedgerFiles,
  afterProjectCreatedIn: (p: Pending, projectId: ProjectId) => void = () => {},
) {
  const { db, now } = ctx;
  const { currentSession } = sessions;
  const { insertSystemMessage } = messages;
  const { requirePm, assertPmNotArchived, privateConversation, validName } = persona;
  const { userHome, resolveFolder, worktreesDir } = files;

  const activeProjectOf = (pmId: PmId): ProjectDbRow | null =>
    db.get<ProjectDbRow>("SELECT * FROM projects WHERE pm_id = ? AND status = 'active'", pmId) ?? null;

  const requireProject = (pmId: PmId): ProjectDbRow => {
    const row = activeProjectOf(pmId);
    if (row === null) throw fail("not_found", `你还没有项目：先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
    return row;
  };

  /** Stable order so the prompt does not change and trigger a needless restart. */
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

  const syncSessionFolders = (project: ProjectDbRow): ProjectFolder[] => {
    const folders = foldersOf(project.id);
    const main = folders.find((f) => f.isMain);
    const others = folders.filter((f) => !f.isMain).map((f) => f.path);
    const t = now();
    const session = currentSession(project.conversation_id);
    if (session !== null && main !== undefined) {
      const usesWorktrees = db.get("SELECT 1 AS x FROM workers WHERE project_id = ? AND workspace = 'worktree' LIMIT 1", project.id) !== undefined;
      let addDirs = others;
      if (usesWorktrees) {
        const primaryProjWt = projectWorktreesDir(worktreesDir, project.id);
        const primaryRealKey = normalizePathForComparison(realpathOrLiteral(primaryProjWt, userHome));
        const wtDirs = [primaryProjWt];
        const seenKeys = new Set<string>([
          normalizePathForComparison(primaryProjWt),
          primaryRealKey,
        ]);
        for (const extraRoot of files.extraWorktreeRoots?.() ?? []) {
          const candidate = projectWorktreesDir(extraRoot, project.id);
          if (!existsSync(candidate)) continue;
          const candidateKey = normalizePathForComparison(realpathOrLiteral(candidate, userHome));
          if (!seenKeys.has(candidateKey)) {
            seenKeys.add(candidateKey);
            wtDirs.push(candidate);
          }
        }
        addDirs = [...others, ...wtDirs];
      }
      db.run("UPDATE agent_sessions SET cwd = ?, add_dirs = ?, updated_at = ? WHERE id = ?", main.path, JSON.stringify(addDirs), t, session.id);
    }
    db.run(
      `UPDATE agent_sessions SET add_dirs = ?, updated_at = ?
       WHERE worker_id IN (SELECT id FROM workers WHERE project_id = ? AND workspace = 'main' AND status = 'open')`,
      JSON.stringify(others),
      t,
      project.id,
    );
    return folders;
  };

  const foldersChanged = (p: Pending, project: ProjectDbRow): ProjectFolder[] => {
    const folders = syncSessionFolders(project);
    p.changes.push({ type: "folders.updated", data: { projectId: project.id, folders } });
    return folders;
  };

  const createProjectIn = (p: Pending, input: CreateProjectInput) => {
    const pm = requirePm(input.pmId);
    assertPmNotArchived(pm.id);
    const existing = activeProjectOf(pm.id);
    if (existing !== null) {
      throw fail("conflict", `${ONE_PROJECT_PER_PM}。${pm.name}现在管的是“${existing.name}”（${projectCard(existing).mainFolder}）`);
    }
    const conversation = privateConversation(pm.id);
    if (conversation === null) throw new Error(`pm ${pm.id} has no conversation`);
    const description = typeof input.description === "string" ? input.description.trim() || null : null;
    if (description !== null && [...description].length > MAX_DESCRIPTION_CHARS) {
      throw fail("invalid", `项目说明最多 ${MAX_DESCRIPTION_CHARS} 个字`);
    }
    const path = resolveFolder(input.folder);
    const name = input.name === undefined ? defaultProjectName(path) : validName(input.name, "项目");
    const t = now();
    const row = db.get<ProjectDbRow>(
      `INSERT INTO projects (name, description, status, pm_id, conversation_id, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?) RETURNING *`,
      name,
      description,
      pm.id,
      conversation.id,
      t,
      t,
    )!;
    const mainFolder = toProjectFolder(
      db.get<ProjectFolderDbRow>(
        "INSERT INTO project_folders (project_id, path, is_main, added_at) VALUES (?, ?, 1, ?) RETURNING *",
        row.id,
        path,
        t,
      )!,
    );
    const project = toProject(row);
    p.changes.push({ type: "project.created", data: { project } });
    foldersChanged(p, row);
    insertSystemMessage(p, conversation.id, { event: "project.created", projectId: project.id }, `项目已建好：${name}，主文件夹 ${path}`);
    afterProjectCreatedIn(p, project.id);
    return { project, mainFolder };
  };

  const attachIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.attach">): HubResult<"project.attach"> => {
    assertPmNotArchived(caller.pmId);
    const project = requireProject(caller.pmId);
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
    );
    return { text: `已把 ${path} 挂到项目“${project.name}”上，下一条消息起能用。`, data: { project: toProject(project), folder } };
  };

  const detachIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.detach">): HubResult<"project.detach"> => {
    assertPmNotArchived(caller.pmId);
    const project = requireProject(caller.pmId);
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
    );
    return { text: `已把 ${path} 从项目“${project.name}”上移除。`, data: { project: toProject(project), folder } };
  };

  const setupIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.setup">): HubResult<"project.setup"> => {
    assertPmNotArchived(caller.pmId);
    const project = requireProject(caller.pmId);
    const command = validSetupCommand(args.command);
    const row = writeSetupCommandIn(ctx, p, project.id, command);
    const text =
      command === null
        ? `已清除项目“${project.name}”的准备命令：以后建 worktree 后不跑东西，Worker 直接开工。`
        : `已设好项目“${project.name}”的准备命令：以后给 Worker 建好 worktree 后先在里面跑它，跑完 Worker 再开工（已经派出去的不受影响）。`;
    return { text, data: { project: toProject(row), setupCommand: command } };
  };

  const reviewStatusIn = (caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.review-status">): HubResult<"project.review-status"> => {
    assertPmNotArchived(caller.pmId);
    const project = requireProject(caller.pmId);
    const account = validReviewStatusAccount(args.account);
    if (account === null) db.run("DELETE FROM project_review_status WHERE project_id = ?", project.id);
    else {
      db.run(
        `INSERT INTO project_review_status (project_id, account, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET account = excluded.account, updated_at = excluded.updated_at`,
        project.id,
        account,
        now(),
      );
    }
    const text =
      account === null
        ? `已清除项目“${project.name}”的审查盖章账号：以后审查判完，用 gh 当前登录的账号挂提交状态。`
        : `已设好项目“${project.name}”的审查盖章账号 ${account}：以后审查判完，用 gh 里这个账号的登录挂提交状态。账本只记登录名，令牌每次现从 gh 取。`;
    return { text, data: { project: toProject(project), account } };
  };

  const setSetupCommandIn = (p: Pending, projectId: ProjectId, command: string | null): Project => {
    const project = db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ? AND status = 'active'", projectId);
    if (project === undefined) throw fail("not_found", `没有编号 ${projectId} 的在用项目`);
    assertPmNotArchived(project.pm_id);
    return toProject(writeSetupCommandIn(ctx, p, project.id, validSetupCommand(command)));
  };

  return { activeProjectOf, projectCard, syncSessionFolders, createProjectIn, attachIn, detachIn, setupIn, reviewStatusIn, setSetupCommandIn };
}
