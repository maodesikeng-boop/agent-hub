// pnpm smoke：用真 claude 跑 S1～S4（m1-plan 第 4 节）。不进 pnpm check 和 CI；验收时和每次升级 claude 后手动跑。
// - 数据放临时目录，跑完删掉；不碰 ~/.agent-hub。
// - 默认用小模型（AGENT_HUB_DEFAULT_MODEL，默认 claude-haiku-5-5），提示词都很短。
// - claude 的路径：AGENT_HUB_CLAUDE，默认 PATH 里的 claude。用户全局 ~/.claude 的设置照常生效。
// S1 连续聊两轮；S2 重启守护进程后接着聊，记得之前说的；S3 停止：控制消息管用、进程还在；S4 忙时连发两条，下一轮两条都回应到。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_DEFAULT_MODEL, type Message } from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { Client, agentTexts, isAlive, makeEnv, messageById, sleep, waitForStatus, waitUntil, type RunningDaemon } from "../e2e/harness.ts";

const MODEL = process.env[ENV_DEFAULT_MODEL] || "claude-haiku-5-5";
const CLAUDE = process.env.AGENT_HUB_CLAUDE || "claude";
/** 真 claude 一轮最多等多久。 */
const TURN_MS = 180_000;

type Outcome = { name: string; ok: boolean; detail: string };
const outcomes: Outcome[] = [];

const env = makeEnv();
const start = () => env.start({ claudePath: CLAUDE, env: { [ENV_DEFAULT_MODEL]: MODEL } });

async function terminate(daemon: RunningDaemon) {
  daemon.child.kill("SIGTERM");
  return daemon.exited;
}

/** 读会话那一行：进程号和 Claude 的会话 ID（只读，用完就关）。 */
function sessionRow(): { id: number; pid: number | null; vendorSessionId: string } {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    const row = db.get<{ id: number; pid: number | null; vendor_session_id: string }>("SELECT id, pid, vendor_session_id FROM agent_sessions ORDER BY id LIMIT 1")!;
    return { id: row.id, pid: row.pid, vendorSessionId: row.vendor_session_id };
  } finally {
    db.close();
  }
}

/** 驱动层记下的 claude 原始输入输出里，我们写进去的用户消息。 */
function writtenLines(sessionId: number): string[] {
  const file = join(env.home, "state", "logs", "sessions", `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.includes('"isReplay":true'))
    .map((l) => {
      const obj = JSON.parse(l) as { message?: { content?: unknown } };
      const content = obj.message?.content;
      return Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : String(content ?? "");
    });
}

function claudeProcessesOf(vendorSessionId: string): string[] {
  const out = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(vendorSessionId));
}

async function scenario(name: string, fn: () => Promise<string>): Promise<boolean> {
  const t0 = Date.now();
  process.stdout.write(`${name} … `);
  try {
    const detail = await fn();
    outcomes.push({ name, ok: true, detail });
    console.log(`通过（${((Date.now() - t0) / 1000).toFixed(1)} 秒）：${detail}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcomes.push({ name, ok: false, detail });
    console.log(`失败：${detail}`);
    return false;
  }
}

const lastAgentText = (texts: string[]) => texts.at(-1) ?? "";

let daemon: RunningDaemon | undefined;
let client: Client | undefined;
let conversationId = 0;

async function main() {
  console.log(`agent-hub smoke：claude=${CLAUDE}，模型 ${MODEL}，临时数据目录 ${env.dir}`);
  daemon = await start();
  client = await Client.login(daemon);
  conversationId = (await client.state()).conversations[0]!.conversation.id;

  const s1 = await scenario("S1 连续聊两轮", async () => {
    const a = await client!.post(conversationId, "记住暗号：蓝鲸。只回复“记住了”三个字。");
    await waitForStatus(client!, a, "replied", TURN_MS);
    const b = await client!.post(conversationId, "暗号是什么？只回复暗号本身。");
    await waitForStatus(client!, b, "replied", TURN_MS);
    const reply = lastAgentText(agentTexts(await client!.state(), conversationId));
    if (!reply.includes("蓝鲸")) throw new Error(`第二轮回复里没有“蓝鲸”：${reply}`);
    return `第二轮回复“${reply.trim()}”`;
  });

  await scenario("S2 重启后接着聊", async () => {
    if (!s1) throw new Error("S1 没过，跳过");
    const { vendorSessionId } = sessionRow();
    const exit = await terminate(daemon!);
    if (exit.code !== 0) throw new Error(`关机退出码 ${exit.code}`);
    if (claudeProcessesOf(vendorSessionId).length > 0) throw new Error("关机后还有 claude 进程");
    daemon = await start();
    client = client!.withPort(daemon.port);
    const before = (await client.state()).conversations[0]!.messages.length;
    const c = await client.post(conversationId, "我刚才让你记住的暗号是什么？只回复暗号本身。");
    await waitForStatus(client, c, "replied", TURN_MS);
    const reply = lastAgentText(agentTexts(await client.state(), conversationId));
    if (!reply.includes("蓝鲸")) throw new Error(`重启后回复里没有“蓝鲸”：${reply}`);
    return `重启前 ${before} 条消息都在，cookie 仍有效，回复“${reply.trim()}”`;
  });

  await scenario("S3 停止：控制消息管用、进程还在", async () => {
    const a = await client!.post(conversationId, "写一篇 4000 字的中文长文，题目是《海边的一天》，分十节。不要用任何工具。");
    await waitForStatus(client!, a, "processing", TURN_MS);
    const pidBefore = sessionRow().pid;
    // 小模型写得快：开始处理后很快就停
    await sleep(500);
    const status = await client!.stop(conversationId);
    if (status !== 202) throw new Error(`POST stop 返回 ${status}`);
    const stopped = await waitUntil(
      "message stopped",
      async () => {
        const m = messageById(await client!.state(), a);
        return m?.status === "stopped" || m?.status === "replied" || m?.status === "failed" ? m : undefined;
      },
      30_000,
    );
    if (stopped.status !== "stopped") throw new Error(`消息标的是 ${stopped.status}，不是已停止（可能停止前就写完了）`);
    const pidAfter = sessionRow().pid;
    if (pidBefore === null || pidAfter !== pidBefore || !isAlive(pidBefore)) {
      throw new Error(`进程变了或不在了（停止前 ${pidBefore}，停止后 ${pidAfter}）：控制消息可能没管用，退回了 SIGINT`);
    }
    const b = await client!.post(conversationId, "只回复一个字：在");
    await waitForStatus(client!, b, "replied", TURN_MS);
    if (sessionRow().pid !== pidBefore) throw new Error("再发一条时换了进程");
    return `已停止，进程 ${pidBefore} 没换，再发一条照常回复`;
  });

  await scenario("S4 忙时连发两条，下一轮都回应到", async () => {
    const a = await client!.post(conversationId, "写一篇 800 字的中文文章，题目随意。不要用任何工具。");
    await waitForStatus(client!, a, "processing", TURN_MS);
    const b = await client!.post(conversationId, "补充一：等你写完，下一条回复里要提到“苹果”。");
    const c = await client!.post(conversationId, "补充二：下一条回复里还要提到“香蕉”。");
    for (const id of [a, b, c]) await waitForStatus(client!, id, "replied", TURN_MS);
    const state = await client!.state();
    const after = state.conversations[0]!.messages.filter((m: Message) => m.id > c && m.sender === "agent" && m.kind === "text");
    const reply = after.map((m) => m.text).join("\n");
    const merged = writtenLines(sessionRow().id).some((l) => l.includes("【用户连发了 2 条】") && l.includes("补充一") && l.includes("补充二"));
    if (!merged) throw new Error("没在 claude 的输入里找到拼成一条的“【用户连发了 2 条】”");
    if (!reply.includes("苹果") || !reply.includes("香蕉")) throw new Error(`下一轮回复没同时提到苹果和香蕉：${reply.slice(0, 200)}`);
    return `两条拼成一条写进去，下一轮回复同时提到了苹果和香蕉`;
  });
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  console.error("smoke 没跑完：", error);
  exitCode = 1;
} finally {
  let vendorSessionId: string | undefined;
  try {
    vendorSessionId = sessionRow().vendorSessionId;
  } catch {
    // 库还没建出来
  }
  if (daemon) {
    const exit = await terminate(daemon);
    if (exit.code !== 0) {
      console.error(`关机退出码 ${exit.code}`);
      exitCode = 1;
    }
  }
  if (vendorSessionId) {
    const left = claudeProcessesOf(vendorSessionId);
    if (left.length > 0) {
      console.error(`还有 ${left.length} 个 claude 进程没退出`);
      exitCode = 1;
    } else {
      console.log("关机后没有残留的 claude 进程");
    }
  }
  await env.cleanup();
  console.log(`临时数据目录已删除：${existsSync(env.dir) ? "否" : "是"}`);
}
const failed = outcomes.filter((o) => !o.ok);
console.log(`\n结果：${outcomes.length - failed.length}/${outcomes.length} 通过`);
if (failed.length > 0 || outcomes.length < 4) exitCode = 1;
process.exitCode = exitCode;
