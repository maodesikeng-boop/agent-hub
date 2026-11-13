// 账本里的项目（11-03 起一个项目经理就是一个会话）：每个项目经理最多一个进行中的项目，挂在它唯一的那个对话上。
// 建项目、挂和移除文件夹；那个对话的会话的 cwd、addDirs 跟着项目的文件夹走（foldersChanged），下一条消息前驱动层按新值重启。
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { normalizeName, utf8Bytes } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, ProjectFolder, ProjectId } from "../../shared/domain.ts";
import type { HubArgs, HubResult, ProjectCard } from "../../shared/hub.ts";
import { MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_SETUP_COMMAND_BYTES } from "../../shared/limits.ts";
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

/** 建项目（hub project create、建项目经理时选了主文件夹）。folder 是用户或 agent 给的路径，可以带 ~。 */
export interface CreateProjectInput {
  pmId: PmId;
  folder: string;
  /** 不给就用主文件夹的名字。 */
  name?: string;
  description?: string;
}

/** 已经有项目时的回答（用户 11-03 定的说法）。 */
const ONE_PROJECT_PER_PM = "一个项目经理只管一个项目，请新建一个项目经理";

/** 没给项目名、主文件夹的名字又用不了（主文件夹是 /、带换行等控制字符）时的项目名。 */
export const DEFAULT_PROJECT_NAME = "未命名项目";

/**
 * 没给项目名时的默认名：主文件夹的名字，超过 MAX_NAME_CHARS 个字截掉后面的；用不了就用 DEFAULT_PROJECT_NAME。
 * 用户没填过名字，所以这里不报“项目名字不对”。
 */
function defaultProjectName(path: string): string {
  return normalizeName([...basename(path).trim()].slice(0, MAX_NAME_CHARS).join("")) ?? DEFAULT_PROJECT_NAME;
}

export function createLedgerProjects(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  files: LedgerFiles,
) {
  const { db, now } = ctx;
  const { currentSession } = sessions;
  const { insertSystemMessage } = messages;
  const { requirePm, assertPmNotArchived, privateConversation, validName } = persona;
  const { userHome, resolveFolder, worktreesDir } = files;

  /** 这个项目经理进行中的项目（最多一个，数据库有部分唯一索引）。 */
  const activeProjectOf = (pmId: PmId): ProjectDbRow | null =>
    db.get<ProjectDbRow>("SELECT * FROM projects WHERE pm_id = ? AND status = 'active'", pmId) ?? null;

  const requireProject = (pmId: PmId): ProjectDbRow => {
    const row = activeProjectOf(pmId);
    if (row === null) throw fail("not_found", `你还没有项目：先用 ${HUB_COMMAND} project create --folder <主文件夹> 建一个`);
    return row;
  };

  /** 没移除的文件夹，按编号排（顺序固定，免得提示词无端变了触发重启）。 */
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

  /**
   * 按项目现在的文件夹改会话的 cwd、addDirs。正在跑的这一轮不打断，下一条消息前驱动层发现 cwd、addDirs 和启动时不一样，
   * 就 --resume 重启（m2-plan 第 6 节第 3 条）。
   * - 项目经理的会话：cwd 是主文件夹，addDirs 是其他没移除的文件夹；派过在 worktree 里干活的 Worker（M3）的，再带上
   *   <worktreesDir>/<项目编号>/，验收时能看 Worker 的改动。没派过的不带：没用上 Worker 的项目经理不因此重启，
   *   这一层目录也是第一个 worktree 建出来之后才有；
   * - 在主文件夹里干活、还没收工的 Worker 的会话（M3）：addDirs 和项目经理的附加文件夹一样（不带 worktrees 目录）。
   */
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

  /** 项目的文件夹变了：改会话（syncSessionFolders），推 folders.updated。 */
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
    // 只有自己给的名字不对才报错；默认名一定能用
    // 同一个文件夹可以有多个项目经理（各管各的项目）：别的项目的主文件夹也能用，项目名也可以重名，靠项目经理的名字分
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

  /**
   * hub project setup：设置（command 是字符串）或清除（null）项目的 worktree 准备命令。只改 projects.setup_command：
   * 不推变化、不发系统消息、不改会话（提示词里不显示它，项目经理的会话不重启）；下一个建 worktree 的 Worker 起生效。
   */
  const setupIn = (caller: AgentSessionRow & { pmId: PmId }, args: HubArgs<"project.setup">): HubResult<"project.setup"> => {
    assertPmNotArchived(caller.pmId);
    const project = requireProject(caller.pmId);
    let command: string | null = null;
    if (args.command !== null) {
      if (typeof args.command !== "string" || args.command.trim() === "") {
        throw fail("invalid", `准备命令不能是空的；要清除用 ${HUB_COMMAND} project setup --clear`);
      }
      if (args.command.includes("\0")) throw fail("invalid", "准备命令里不能有 NUL 字符");
      if (utf8Bytes(args.command) > MAX_SETUP_COMMAND_BYTES) throw fail("invalid", `准备命令不能超过 ${MAX_SETUP_COMMAND_BYTES} 字节`);
      command = args.command;
    }
    db.run("UPDATE projects SET setup_command = ?, updated_at = ? WHERE id = ?", command, now(), project.id);
    const row = db.get<ProjectDbRow>("SELECT * FROM projects WHERE id = ?", project.id)!;
    const text =
      command === null
        ? `已清除项目“${project.name}”的准备命令：以后建 worktree 后不跑东西，Worker 直接开工。`
        : `已设好项目“${project.name}”的准备命令：以后给 Worker 建好 worktree 后先在里面跑它，跑完 Worker 再开工（已经派出去的不受影响）。`;
    return { text, data: { project: toProject(row), setupCommand: command } };
  };

  return { activeProjectOf, projectCard, syncSessionFolders, createProjectIn, attachIn, detachIn, setupIn };
}
