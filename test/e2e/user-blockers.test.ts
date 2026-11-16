// 要用户本人动手的事由系统挂卡（docs/user-blockers-design.md）的端到端：真守护进程 + 假 claude（项目经理与 Worker）+ 假的未登录 agy。
// 覆盖单元测试替不了的两条真实接线：冷启动后第一次建图（还没问过 agy）、上游步骤自动做完后交棒给下游。
// 两个项目经理各有一步被同一家卡住：两个对话里各一张卡，点一次 Done，两边的步骤都自动开工。
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API_PATHS, askOf, REPORT_END, REPORT_START, vendorSpec, type Message, type RecheckUserBlockerResponse } from "../../src/shared/index.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { wrapScriptAsPlatformCli } from "../fake-cli-shim.ts";
import { Client, makeEnv, messagesOf, waitForStatus, waitUntil, type E2eEnv } from "./harness.ts";

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

function repo(name: string): string {
  const dir = join(env.dir, "code", name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return realpathSync.native(dir);
}

/** 假 agy：没有 loggedIn 标记文件时问模型名单回“请登录”（真 agy 没登录时就这样，退出码 0），起来干活报认证失败；有标记就是登录了。 */
function fakeAgy(loggedIn: string): string {
  const script = join(env.fakeDir, "fake-agy.mjs");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { existsSync } from "node:fs";
const loggedIn = existsSync(${JSON.stringify(loggedIn)});
if (process.argv.includes("models")) {
  console.log(loggedIn ? JSON.stringify({ models: [{ id: "gemini-3-pro", label: "Gemini 3 Pro", currently_selected: true }] }) : "Error: Please sign in to view available models.");
  process.exit(0);
}
if (!loggedIn) {
  console.error("Error: authentication required. Run 'agy' to log in");
  process.exit(1);
}
setInterval(() => {}, 1 << 30);
`,
  );
  chmodSync(script, 0o755);
  return wrapScriptAsPlatformCli(script, env.fakeDir, "fake-agy");
}

function query<T>(sql: string, ...params: Array<string | number>): T[] {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return db.all<T>(sql, ...params);
  } finally {
    db.close();
  }
}

type StepRow = { graph_id: number; node_key: string; status: string; waiting_for: string | null; active_worker_id: number | null };
const step = (graphId: number, key: string) =>
  query<StepRow>("SELECT graph_id, node_key, status, waiting_for, active_worker_id FROM task_graph_steps WHERE graph_id = ? AND node_key = ?", graphId, key)[0];
const graphIdOf = (out: string) => Number(/#(\d+)/.exec(out)?.[1]);

const report = `做完了。\n\n${REPORT_START}\n状态: 做完了\n摘要: 实现好了\nPR: 无\n提交: 无\n测试: 无\n偏离: 无\n交棒: 无\n问题: 无\n${REPORT_END}`;

const blockerCards = (messages: readonly Message[]) => messages.filter((m) => askOf(m)?.blockerRef !== undefined);

describe("要用户动手的事：真守护进程", { timeout: 90_000 }, () => {
  it("冷启动第一次建图、上游自动做完交棒：两个项目经理各一张卡；点一次 Done 两边都开工", async () => {
    env = makeEnv();
    const loggedIn = join(env.fakeDir, "agy-logged-in");
    const agyPath = fakeAgy(loggedIn);
    env.setScript({ sessions: [{ role: "pm", script: { defaultTurn: { steps: [{ text: "收到" }] } } }, { role: "worker", script: { defaultTurn: { steps: [{ text: report }] } } }] });
    const daemon = await env.start({ env: { [vendorSpec("agy").cli.envVar]: agyPath } });
    const client = await Client.login(daemon);

    const pm1 = await client.createPm({ name: "小林", mode: "manage_only", persona: "", folder: repo("one") });
    await waitForStatus(client, await client.post(pm1.conversationId, "在吗"), "replied", 20_000);
    const pm1Pid = env.envs()[0]!.pid;
    const hub = async (pid: number, args: string[], stdin: string) => {
      const r = await env.runHub(pid, args, { stdin });
      return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
    };

    // 冷启动：守护进程还没问过 agy，第一次建图就要认出没登录
    const first = await hub(pm1Pid, ["graph", "create", "--stdin"], JSON.stringify({ title: "验收一", steps: [{ key: "verify", title: "验收", brief: "跑一遍", vendor: "agy" }] }));
    expect(first.code, first.out).toBe(0);
    const g1 = graphIdOf(first.out);
    expect(step(g1, "verify")).toMatchObject({ status: "waiting", waiting_for: "user", active_worker_id: null });
    expect(query<{ n: number }>("SELECT count(*) AS n FROM workers")[0]!.n).toBe(0);

    const pm2 = await client.createPm({ name: "小周", mode: "manage_only", persona: "", folder: repo("two") });
    await waitForStatus(client, await client.post(pm2.conversationId, "在吗"), "replied", 20_000);
    const pm2Pid = env.envs().at(-1)!.pid;
    expect(pm2Pid).not.toBe(pm1Pid);

    // 上游 impl 由假 claude Worker 汇报做完了，系统自动交棒给 agy 的 verify：不派 Worker，挂卡等用户
    const second = await hub(
      pm2Pid,
      ["graph", "create", "--stdin"],
      JSON.stringify({ title: "实现加验收", steps: [{ key: "impl", title: "实现", brief: "写代码" }, { key: "verify", title: "验收", brief: "跑一遍", vendor: "agy" }] }),
    );
    expect(second.code, second.out).toBe(0);
    const g2 = graphIdOf(second.out);
    await waitUntil("impl 做完", () => (step(g2, "impl")?.status === "done" ? true : undefined), 40_000);
    await waitUntil("verify 等用户", () => (step(g2, "verify")?.status === "waiting" ? true : undefined), 10_000);
    expect(step(g2, "verify")).toMatchObject({ waiting_for: "user", active_worker_id: null });
    expect(query<{ n: number }>("SELECT count(*) AS n FROM workers")[0]!.n).toBe(1);

    const state = await client.state();
    const cards1 = blockerCards(messagesOf(state, pm1.conversationId));
    const cards2 = blockerCards(messagesOf(state, pm2.conversationId));
    expect(cards1).toHaveLength(1);
    expect(cards2).toHaveLength(1);
    const blockerId = askOf(cards1[0]!)!.blockerRef!.blockerId;
    expect(askOf(cards2[0]!)!.blockerRef!.blockerId).toBe(blockerId);
    expect(cards2[0]!.text).toContain("Antigravity 没登录");

    // 登录好了，只在第二个对话的卡上点一次 Done
    writeFileSync(loggedIn, "");
    const res = await client.postJson(API_PATHS.recheckUserBlocker(blockerId), undefined);
    expect(res.status).toBe(200);
    expect(((await res.json()) as RecheckUserBlockerResponse).resolved).toBe(true);
    for (const [graphId, key] of [[g1, "verify"], [g2, "verify"]] as const) {
      const row = step(graphId, key)!;
      expect(row.status).toBe("running");
      expect(row.active_worker_id).not.toBeNull();
    }
    const after = await client.state();
    for (const conversationId of [pm1.conversationId, pm2.conversationId]) {
      const cards = blockerCards(messagesOf(after, conversationId));
      expect(cards.map((m) => askOf(m)?.answered)).toEqual([true]);
    }
  });
});
