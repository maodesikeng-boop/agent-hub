// S15 worktree 准备命令（hub project setup）：真 claude。项目是本仓库的一个本地克隆（有 pnpm-lock.yaml）。
// 项目经理配好 `pnpm install --frozen-lockfile --ignore-scripts` 再派 Worker；Worker 不装依赖，直接跑一个测试文件。
// 看：准备命令跑成功（日志）、Worker 起来时 worktree 里已经有 node_modules、任务说明前面有“已经跑过”那一行、
// Worker 没敲 install、测试跑了、汇报回到项目经理。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_COMMAND, workerEventOf } from "../../src/shared/index.ts";
import { messagesOf, waitUntil } from "../e2e/harness.ts";
import { MODEL, Smoke, TURN_MS, expect, scenario, type Outcome } from "./kit.ts";

const hub = HUB_COMMAND;
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SETUP = "pnpm install --frozen-lockfile --ignore-scripts";
const TEST_FILE = "src/shared/worker.test.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export async function runSetup(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S15")) return;
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, "S15 准备命令：配好 pnpm install，派 Worker，Worker 不用自己装就能跑测试", async () => {
    const dir = join(smoke.env.dir, "code", "s15");
    git(REPO_ROOT, "clone", "-q", REPO_ROOT, dir);
    git(dir, "config", "user.name", "smoke");
    git(dir, "config", "user.email", "smoke@example.com");
    const tasks = smoke.folder("tasks", {
      "setup.txt": `${SETUP}\n`,
      "task.txt": [
        "不要安装任何依赖（不要运行 pnpm install、npm install 这类命令）。",
        `直接用 Bash 运行 \`pnpm exec vitest run ${TEST_FILE}\`，看它过没过。不要改任何文件。`,
        "按汇报格式汇报，摘要里写通过了几条测试。",
      ].join("\n"),
    });
    const { conversationId: chat } = await smoke.client.createPm({ name: "小林", mode: "hands_on", defaultModel: MODEL, persona: "小林：简洁、直接。", folder: dir });
    const command = `${hub} project setup --stdin < ${tasks}/setup.txt && ${hub} worker start --title 跑测试 --stdin < ${tasks}/task.txt`;
    await smoke.ask(chat, `用 Bash 原样运行下面这一条命令（不要拆开，不要改），运行完只回复“派了”：\n\n${command}`);
    const setupCommand = smoke.query<{ setup_command: string | null }>("SELECT setup_command FROM projects")[0]?.setup_command;
    expect(setupCommand === SETUP, `项目的准备命令是 ${JSON.stringify(setupCommand)}`);
    const [worker] = smoke.query<{ id: number; worker_conversation_id: number; worktree_path: string | null }>("SELECT * FROM workers");
    expect(worker?.worktree_path, `没派出在 worktree 里干活的 Worker`);

    const line = await waitUntil(
      "Worker 的汇报",
      async () => messagesOf(await smoke.client.state(), chat).map(workerEventOf).find((m) => m !== null && m.event !== "started" && m.event !== "ended"),
      TURN_MS * 3,
    );
    expect(line.event === "report", `Worker 没有正常汇报：${JSON.stringify(line)}`);
    const log = readFileSync(join(smoke.env.home, "state", "logs", "setup", `worker-${worker!.id}.log`), "utf8");
    expect(log.includes("结束（ok，退出码 0）"), `准备命令没跑成功，日志最后：${log.slice(-800)}`);
    expect(existsSync(join(worker!.worktree_path!, "node_modules", ".bin", "vitest")), "worktree 里没有 node_modules/.bin/vitest");
    const task = smoke.query<{ text: string }>("SELECT text FROM messages WHERE conversation_id = ? AND sender = 'pm' ORDER BY id LIMIT 1", worker!.worker_conversation_id)[0]!;
    expect(task.text.startsWith("【系统】已经在这个 worktree 里跑过项目的准备命令"), `任务说明前面没有“已经跑过”：${task.text.slice(0, 200)}`);
    const sessionId = smoke.query<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ?", worker!.worker_conversation_id)[0]!.id;
    const commands = smoke.bashCommands(sessionId);
    expect(commands.some((c) => c.includes("vitest")), `Worker 没跑测试：${JSON.stringify(commands)}`);
    expect(!commands.some((c) => /\b(pnpm|npm|yarn)\s+(i|install|add)\b/.test(c)), `Worker 自己装了依赖：${JSON.stringify(commands)}`);
    expect(line.status === "done", `Worker 汇报的状态是 ${line.status}：${line.summary}`);
    const seconds = /用时 (\d+) 秒/.exec(task.text)?.[1];
    return `准备命令跑了 ${seconds} 秒；Worker 敲的命令 ${JSON.stringify(commands)}；汇报“${line.status}：${line.summary}”`;
  });
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: "S15（收尾）", ok: false, detail: problems.join("；") });
}
