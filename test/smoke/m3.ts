// M3 的 S11、S12、S13（m3-plan 第 3 节“真 claude 冒烟”）：Worker。每个场景自己起一个守护进程和临时数据目录。
// 让项目经理派活时给它一条现成的命令（任务说明放在数据目录外的文件里，--stdin < 文件），不靠它自己转述，结果稳一些。
// S11 默认档 auto：项目经理写文件、git commit、hub status 都不被拦；顺便看额度 utilization 是不是 0～1 的小数。
// S12 Worker 写不了记忆：约定文件（工作目录里、附加文件夹里）、~/.claude/ 下的探针、自动记忆都写不了，普通文件照样能写；
//     只读的 Worker（dontAsk 档）能读、写不了。
// S13 整条路：项目经理派一个 haiku Worker 改一行、提交；汇报回来；用户在会话里说清楚“合并到 main，删掉 worktree，然后让 Worker 收工”，项目经理照做。
// S14 Worker 干到一半关机再启动（验收第 11 条，PR #35 审查第 1、2 条）：不发“这一轮没做完”；重启后恢复说明、重发说明和
//     任务原文写在同一行，Worker 接着做完，汇报回到项目经理。
// S19 用户在网页上直接对 Worker 说：Worker 收到带【用户直接对你说】的原文、照做并汇报；项目经理收到“用户直接对 Worker 说的话”，
//     回复里提到了这件事；之后汇报也到了项目经理。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  HUB_COMMAND,
  PRODUCT_NAME,
  RESEND_NOTE,
  RESTART_RECOVERY_NOTE,
  USER_TO_WORKER_TAG,
  userToWorkerHeader,
  workerEventOf,
  type WorkerMessageMeta,
} from "../../src/shared/index.ts";
import { messagesOf, waitUntil } from "../e2e/harness.ts";
import { MODEL, Smoke, TURN_MS, expect, scenario, type Outcome } from "./kit.ts";

const hub = HUB_COMMAND;

/** 每个场景的外壳：起、跑、收尾；收尾发现问题或场景失败，就把数据目录留着。 */
async function inFreshSmoke(outcomes: Outcome[], name: string, fn: (smoke: Smoke) => Promise<string>): Promise<void> {
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, name, () => fn(smoke));
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) {
    outcomes.push({ name: `${name}（收尾）`, ok: false, detail: problems.join("；") });
    console.log(`  收尾发现问题：${problems.join("；")}`);
  }
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** 有一次提交的 git 仓库（用户名、邮箱写在仓库自己的配置里，worktree 共用），返回真实路径。 */
function repo(smoke: Smoke, name: string, files: Record<string, string>): string {
  const dir = smoke.folder(name, files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "smoke");
  git(dir, "config", "user.email", "smoke@example.com");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

async function pmWithFolder(smoke: Smoke, name: string, folder: string, mode: "hands_on" | "manage_only" = "hands_on"): Promise<number> {
  const { conversationId } = await smoke.client.createPm({ name, mode, defaultModel: MODEL, persona: `${name}：简洁、直接。`, folder });
  return conversationId;
}

/** 项目经理对话里那几行（kind worker）。 */
async function workerLines(smoke: Smoke, pmConversationId: number): Promise<WorkerMessageMeta[]> {
  return messagesOf(await smoke.client.state(), pmConversationId).flatMap((m) => {
    const meta = workerEventOf(m);
    return meta === null ? [] : [meta];
  });
}

/** 等 n 个 Worker 各自有了结果（汇报、这一轮没做完、建 worktree 失败）。 */
async function waitResults(smoke: Smoke, pmConversationId: number, n: number): Promise<WorkerMessageMeta[]> {
  return waitUntil(
    `${n} 个 Worker 的结果`,
    async () => {
      const done = (await workerLines(smoke, pmConversationId)).filter((l) => l.event !== "started" && l.event !== "ended");
      return new Set(done.map((l) => l.workerId)).size >= n ? done : undefined;
    },
    TURN_MS * 2,
  );
}

/** 等这个对话里的消息都有了结果（没有排队中、已送达、处理中的）：项目经理把收到的汇报都处理完了。 */
async function waitSettled(smoke: Smoke, conversationId: number): Promise<void> {
  await waitUntil(
    `对话 ${conversationId} 都处理完`,
    async () => {
      const busy = messagesOf(await smoke.client.state(), conversationId).some((m) => m.status === "queued" || m.status === "delivered" || m.status === "processing");
      return busy ? undefined : true;
    },
    TURN_MS * 2,
  );
}

type WorkerDbRow = { id: number; worker_conversation_id: number; readonly: number; workspace: string; branch: string | null; worktree_path: string | null; status: string };
const workers = (smoke: Smoke) => smoke.query<WorkerDbRow>("SELECT * FROM workers ORDER BY id");
const sessionIdOf = (smoke: Smoke, conversationId: number) =>
  smoke.query<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1", conversationId)[0]!.id;

/** 这一会话 Worker 的回复文字（合起来）。 */
async function workerReplies(smoke: Smoke, worker: WorkerDbRow): Promise<string> {
  return messagesOf(await smoke.client.state(), worker.worker_conversation_id)
    .filter((m) => m.sender === "agent" && m.kind === "text")
    .map((m) => m.text)
    .join("\n");
}

/** Claude Code 给这个临时目录下的仓库建的自动记忆目录（~/.claude/projects/<路径换成 ->/memory/）里所有文件的内容。 */
function autoMemoryFiles(smoke: Smoke): Record<string, string> {
  const root = join(homedir(), ".claude", "projects");
  const token = basename(smoke.env.dir);
  const files: Record<string, string> = {};
  if (!existsSync(root)) return files;
  for (const project of readdirSync(root).filter((d) => d.includes(token))) {
    const memory = join(root, project, "memory");
    if (!existsSync(memory)) continue;
    for (const file of readdirSync(memory, { recursive: true }) as string[]) {
      const path = join(memory, file);
      try {
        files[path] = readFileSync(path, "utf8");
      } catch {
        // 目录
      }
    }
  }
  return files;
}

/** 额度里各窗口的 utilization（W4 按 0～1 的小数显示）。 */
async function utilizations(smoke: Smoke): Promise<number[]> {
  return (await smoke.client.state()).sessions.flatMap((s) => Object.values(s.rateLimit?.windows ?? {}).map((w) => w.utilization));
}

export async function runM3(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S11")) {
    await inFreshSmoke(outcomes, "S11 默认档 auto：写文件、git commit、hub status 都不被拦", async (smoke) => {
      const dir = repo(smoke, "s11", { "README.md": "# s11\n" });
      const chat = await pmWithFolder(smoke, "阿周", dir);
      const { replies } = await smoke.ask(
        chat,
        `用 Write 工具在当前目录新建 s11.txt，内容是 ok。然后用 Bash 运行 \`git add s11.txt && git commit -m s11\`，再运行 \`${hub} status\`。做完只回复“好了”。`,
      );
      const session = await smoke.currentSession(chat);
      const denials = smoke.permissionDenials(session.sessionId);
      expect(denials.length === 0, `有调用被权限拦了：${denials.join(" | ")}`);
      expect(existsSync(join(dir, "s11.txt")), `没写出 s11.txt；回复：${replies.join("|")}`);
      expect(git(dir, "log", "-1", "--format=%s") === "s11", `最新提交不是 s11：${git(dir, "log", "--oneline", "-3")}`);
      const statusCalls = smoke.query<{ ok: number }>("SELECT ok FROM hub_calls WHERE command = 'status'");
      expect(statusCalls.some((c) => c.ok === 1), `hub_calls 里没有成功的 status：${JSON.stringify(statusCalls)}`);
      const init = smoke.sessionLog(session.sessionId).find((e) => e.type === "system" && e.subtype === "init");
      const mode = init?.permissionMode;
      expect(mode === "auto", `system/init 里的 permissionMode 是 ${String(mode)}，不是 auto`);
      const used = await utilizations(smoke);
      expect(used.length > 0 && used.every((u) => typeof u === "number" && u >= 0 && u <= 1), `额度 utilization 不是 0～1 的小数：${JSON.stringify(used)}`);
      return `permissionMode=auto，Write、git commit、${hub} status 都没被拦；额度 utilization ${JSON.stringify(used)}`;
    });
  }

  if (only("S12")) {
    await inFreshSmoke(outcomes, "S12 Worker 写不了记忆（带附加文件夹）；只读的 Worker 能读、写不了", async (smoke) => {
      const secret = `FIG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const original = "原样，不能改\n";
      const main = smoke.folder("s12", { "AGENTS.md": original, "readme.txt": `暗号是 ${secret}\n` });
      const extra = smoke.folder("s12-docs", { "AGENTS.md": original, "CLAUDE.md": original });
      const probe = join(homedir(), ".claude", `${PRODUCT_NAME}-smoke-probe-${secret}.md`);
      const memoryBefore = autoMemoryFiles(smoke);
      const tasks = smoke.folder("tasks", {
        "memory.txt": [
          `这是 ${PRODUCT_NAME} 的权限冒烟测试：用户要你真的调用 Write 工具去试下面每一项，拦不拦由系统决定，你不用自己先判断能不能写。`,
          "每一项都只用 Write 工具（不要用 Bash、不要写脚本），被拒绝了就记下来，接着做下一项，不要换别的办法绕过：",
          "1. 把当前目录的 AGENTS.md 整个改写成“改过了”。",
          `2. 把 ${extra}/AGENTS.md 整个改写成“改过了”。`,
          `3. 把 ${extra}/CLAUDE.md 整个改写成“改过了”。`,
          `4. 新建文件 ${probe}，内容“探针”。`,
          `5. 记住暗号 ${secret}，以后都用得上（存进你的记忆）。`,
          "6. 新建当前目录下的 ok.txt，内容“普通文件”。",
          `7. 新建 ${extra}/ok.txt，内容“普通文件”。`,
          "最后按汇报格式汇报，摘要里逐项写成功还是被拒。",
        ].join("\n"),
        "readonly.txt": "读一下当前目录的 readme.txt。然后用 Write 工具（不要用 Bash）新建当前目录的 ro.txt，内容是 readme.txt 里的暗号；被拒了就算了。汇报的摘要里写出暗号原文。",
      });
      const chat = await pmWithFolder(smoke, "阿周", main);
      const command =
        `${hub} project attach ${extra} && ` +
        `${hub} worker start --title 记忆测试 --no-worktree --stdin < ${tasks}/memory.txt && ` +
        `${hub} worker start --title 只读测试 --no-worktree --readonly --stdin < ${tasks}/readonly.txt`;
      try {
        await smoke.ask(chat, `用 Bash 原样运行下面这一条命令（不要拆开，不要改），运行完只回复“派了”：\n\n${command}`);
        const rows = workers(smoke);
        expect(rows.length === 2, `没派出两个 Worker：${JSON.stringify(rows)}；agent 敲的命令：${JSON.stringify(smoke.bashCommands(sessionIdOf(smoke, chat)))}`);
        await waitResults(smoke, chat, 2);
        const [memory, readonly] = rows as [WorkerDbRow, WorkerDbRow];

        // 记忆：四个文件都没变、都在 permission_denials 里；普通文件能写
        const memorySession = sessionIdOf(smoke, memory.worker_conversation_id);
        const denials = smoke.permissionDenials(memorySession);
        const unchanged = [join(main, "AGENTS.md"), join(extra, "AGENTS.md"), join(extra, "CLAUDE.md")];
        for (const file of unchanged) {
          expect(readFileSync(file, "utf8") === original, `${file} 被改了`);
          expect(denials.some((d) => d.includes(file)), `${file} 不在 permission_denials 里（Worker 可能没去试）：${denials.join(" | ")}`);
        }
        expect(!existsSync(probe), `探针文件 ${probe} 被写出来了`);
        expect(denials.some((d) => d.includes(basename(probe))), `探针不在 permission_denials 里：${denials.join(" | ")}`);
        const memoryAfter = autoMemoryFiles(smoke);
        expect(JSON.stringify(memoryAfter) === JSON.stringify(memoryBefore), `自动记忆目录变了：${JSON.stringify(Object.keys(memoryAfter))}`);
        expect(existsSync(join(main, "ok.txt")), `当前目录的普通文件没写出来；Worker 说：${(await workerReplies(smoke, memory)).slice(-400)}`);
        expect(existsSync(join(extra, "ok.txt")), "附加文件夹里的普通文件没写出来");

        // 只读：读得到暗号，写不了
        const readonlyReplies = await workerReplies(smoke, readonly);
        expect(readonly.readonly === 1, "第二个 Worker 不是只读的");
        expect(!existsSync(join(main, "ro.txt")), "只读的 Worker 写出了 ro.txt");
        expect(readonlyReplies.includes(secret), `只读的 Worker 没读到暗号：${readonlyReplies.slice(-300)}`);
        const readonlyDenials = smoke.permissionDenials(sessionIdOf(smoke, readonly.worker_conversation_id));
        return `记忆 Worker 被拒 ${denials.length} 次（三个约定文件和探针都没变），普通文件写成了，自动记忆目录没变；只读 Worker 读到暗号、写入被拒 ${readonlyDenials.length} 次`;
      } finally {
        rmSync(probe, { force: true });
      }
    });
  }

  if (only("S13")) {
    await inFreshSmoke(outcomes, "S13 整条路：派活 → 汇报 → 用户让合并到 main、删 worktree、让 Worker 收工", async (smoke) => {
      const dir = repo(smoke, "s13", { "README.md": "# s13\n" });
      const chat = await pmWithFolder(smoke, "小林", dir, "manage_only");
      await smoke.ask(chat, `派一个 Worker（用 ${MODEL}，在 worktree 里干）：在 README.md 末尾加一行 hello，然后提交。派完只回复“派了”。`);
      const [worker] = workers(smoke);
      expect(worker?.workspace === "worktree", `没派出在 worktree 里干活的 Worker：${JSON.stringify(workers(smoke))}`);
      const results = await waitResults(smoke, chat, 1);
      expect(results.some((r) => r.event === "report"), `Worker 没有汇报：${JSON.stringify(results)}`);
      expect(git(dir, "log", "--format=%s", worker!.branch!).split("\n").length >= 2, `Worker 的分支上没有新提交：${git(dir, "log", "--oneline", worker!.branch!)}`);
      await waitSettled(smoke, chat);

      const { replies } = await smoke.ask(chat, "把它的分支合并到 main（只合本地，分支留着），删掉它的 worktree，然后让这个 Worker 收工。");
      await waitSettled(smoke, chat);
      const readme = readFileSync(join(dir, "README.md"), "utf8");
      expect(readme.includes("hello"), `主文件夹的 README.md 里没有 hello：${readme}；回复：${replies.join("|")}`);
      const logSubjects = git(dir, "log", "--format=%s").split("\n").filter(Boolean);
      expect(logSubjects.length >= 2, `git log 里没有合入提交：${git(dir, "log", "--oneline", "-5")}`);
      const worktrees = git(dir, "worktree", "list", "--porcelain");
      expect(!worktrees.includes(worker!.worktree_path!), `worktree 没删：${worktrees}`);
      expect(git(dir, "branch", "--list", worker!.branch!) !== "", `分支 ${worker!.branch} 被删了`);
      expect(git(dir, "remote") === "", "多出了 remote");
      const lines = await workerLines(smoke, chat);
      expect(lines.some((l) => l.event === "ended"), `没有“已收工”那一行：${JSON.stringify(lines.map((l) => l.event))}`);
      const denials = smoke.permissionDenials(sessionIdOf(smoke, chat));
      return `最新提交“${logSubjects[0]}”，worktree 已删、分支留着，Worker 已收工；项目经理被拒 ${denials.length} 次`;
    });
  }

  if (only("S14")) {
    await inFreshSmoke(outcomes, "S14 Worker 干到一半关机，再启动后接着做完、汇报回来", async (smoke) => {
      const dir = repo(smoke, "s14", { "README.md": "# s14\n" });
      const tasks = smoke.folder("tasks", {
        "slow.txt": "先用 Bash 前台运行 `sleep 15`（等它跑完），然后在 README.md 末尾加一行 hello，git add 并 git commit -m hello，最后按汇报格式汇报。",
      });
      const chat = await pmWithFolder(smoke, "小林", dir);
      await smoke.ask(chat, `用 Bash 原样运行这一条命令，运行完只回复“派了”：\n\n${hub} worker start --title 慢活 --stdin < ${tasks}/slow.txt`);
      const [worker] = workers(smoke);
      expect(worker?.workspace === "worktree", `没派出在 worktree 里干活的 Worker：${JSON.stringify(workers(smoke))}`);
      const sessionId = await waitUntil("Worker 会话起来了", () => smoke.query<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ?", worker!.worker_conversation_id)[0]?.id, TURN_MS);
      // 等它在跑 sleep 时关机
      await waitUntil("Worker 开始 sleep", () => (smoke.bashCommands(sessionId).some((c) => c.includes("sleep")) ? true : undefined), TURN_MS);
      const exit = await smoke.terminate();
      expect(exit.code === 0, `关机退出码 ${exit.code}`);
      const task = smoke.query<{ id: number; text: string; status: string }>("SELECT id, text, status FROM messages WHERE conversation_id = ? AND sender = 'pm'", worker!.worker_conversation_id)[0]!;
      expect(task.status === "processing" || task.status === "delivered", `关机后任务说明是 ${task.status}，应该还是处理中`);
      const before = smoke.writtenTexts(sessionId).length;

      await smoke.start();
      const results = await waitResults(smoke, chat, 1);
      expect(!results.some((r) => r.event === "turn_failed"), `项目经理收到了“这一轮没做完”：${JSON.stringify(results)}`);
      const report = results.find((r) => r.event === "report");
      expect(report, `Worker 没有汇报：${JSON.stringify(results)}`);
      // 重启后只写了一行：恢复说明、重发说明、任务原文
      const after = smoke.writtenTexts(sessionId).slice(before);
      const expected = `${RESTART_RECOVERY_NOTE}\n\n${RESEND_NOTE}\n\n${task.text}`;
      expect(after.length === 1 && after[0] === expected, `重启后写进去的不是一行：${JSON.stringify(after)}`);
      expect(git(dir, "log", "--format=%s", worker!.branch!).split("\n")[0] === "hello", `分支上没有 hello 提交：${git(dir, "log", "--oneline", worker!.branch!)}`);
      await waitSettled(smoke, chat);
      return `关机时没发“这一轮没做完”，重启后一行写进去（恢复说明 + 重发说明 + 任务），汇报“${report!.status}：${report!.summary}”回到项目经理`;
    });
  }
  if (only("S19")) {
    await inFreshSmoke(outcomes, "S19 用户直接对 Worker 说：Worker 照做、汇报；项目经理知道用户说了什么", async (smoke) => {
      const dir = repo(smoke, "s19", { "README.md": "# s19\n" });
      const tasks = smoke.folder("tasks", { "notes.txt": "在 notes.txt 里写一行 notes，git add 并 git commit -m notes，然后按汇报格式汇报。" });
      const chat = await pmWithFolder(smoke, "小林", dir);
      await smoke.ask(chat, `用 Bash 原样运行这一条命令，运行完只回复“派了”。它汇报回来以后先别让它收工，我还要直接跟它说话：\n\n${hub} worker start --title 写笔记 --model ${MODEL} --stdin < ${tasks}/notes.txt`);
      const [worker] = workers(smoke);
      expect(worker?.workspace === "worktree", `没派出在 worktree 里干活的 Worker：${JSON.stringify(workers(smoke))}`);
      await waitResults(smoke, chat, 1);
      await waitSettled(smoke, chat);

      // 用户在 Worker 页面说一句（网页走的就是这个 POST）
      const said = "顺便在 README.md 末尾加一行 direct-from-user，然后提交。";
      const messageId = await smoke.client.post(worker!.worker_conversation_id, said);
      const workerSession = sessionIdOf(smoke, worker!.worker_conversation_id);
      const reports = await waitUntil(
        "第二份汇报",
        async () => {
          const r = (await workerLines(smoke, chat)).filter((l) => l.event === "report" || l.event === "turn_failed");
          return r.length >= 2 ? r : undefined;
        },
        TURN_MS * 2,
      );
      expect(reports[1]!.event === "report", `第二轮不是汇报：${JSON.stringify(reports[1])}`);
      const written = smoke.writtenTexts(workerSession);
      expect(written.some((t) => t.includes(`${USER_TO_WORKER_TAG}\n${said}`)), `Worker 收到的不带标签：${JSON.stringify(written.slice(-2))}`);
      const readme = git(worker!.worktree_path!, "show", "HEAD:README.md");
      expect(readme.includes("direct-from-user"), `Worker 没照用户说的改 README：${readme}`);
      const status = smoke.query<{ status: string }>("SELECT status FROM messages WHERE id = ?", messageId)[0]?.status;
      expect(status === "replied", `用户那条消息是 ${status}`);

      // 项目经理：会话里有 user_message 那一行，收到了带开头的原文，回了一句提到 README
      const lines = await workerLines(smoke, chat);
      expect(lines.some((l) => l.event === "user_message" && l.summary === said), `项目经理会话里没有 user_message 那一行：${JSON.stringify(lines.map((l) => l.event))}`);
      await waitSettled(smoke, chat);
      const pmWritten = smoke.writtenTexts(sessionIdOf(smoke, chat));
      const header = userToWorkerHeader(worker!.id, "写笔记");
      expect(pmWritten.some((t) => t.includes(header) && t.includes(said)), `项目经理没收到用户对 Worker 说的话：${JSON.stringify(pmWritten.slice(-3))}`);
      const noticeId = messagesOf(await smoke.client.state(), chat).find((m) => workerEventOf(m)?.event === "user_message")!.id;
      const replies = await smoke.repliesAfter(chat, noticeId);
      expect(replies.some((r) => r.includes("README")), `项目经理之后的回复没提到 README：${replies.join("|")}`);
      return `Worker 收到带标签的原文并照做（README 有 direct-from-user），汇报“${reports[1]!.summary}”；项目经理收到通知并回复：${replies[0]?.slice(0, 60)}`;
    });
  }
}
