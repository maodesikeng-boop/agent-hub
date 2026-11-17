// 审查只查不修的端到端（docs/review-verify-only-design.md 第 3.1 节）：真守护进程 + 假 claude 当项目经理 + 临时 git 仓库和本地 bare 远端。
// 项目经理的命令用它拿到的令牌经 run/bin/hub 发（env.runHub，就像它自己敲的）。三条以前会退成普通 Worker 的路：
// 补建的单步审查图、用 --no-worktree 派审查步骤、上一步在主文件夹里干的审查步骤。
// 不靠 Worker 进程：推送用守护进程写进审查 Worker 启动目录的 pre-push 钩子、照 review.ts 的环境变量跑 git，在 Worker 沙箱里也能跑。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REVIEW_HOOKS_DIR, reviewPushGuardEnv } from "../../src/shared/index.ts";
import { sessionLaunchDir } from "../../src/shared/paths.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { Client, firstPidOfConversation, makeEnv, waitForStatus, waitUntil, type E2eEnv } from "./harness.ts";

let env: E2eEnv;
afterEach(async () => {
  await env?.cleanup();
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

/** 有一次提交、推到本地 bare 远端 origin 的仓库。 */
function repoWithOrigin(): { dir: string; origin: string } {
  const dir = join(env.dir, "code", "foo");
  const origin = join(env.dir, "origin.git");
  mkdirSync(dir, { recursive: true });
  git(env.dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "main");
  return { dir: realpathSync.native(dir), origin };
}

function query<T>(sql: string, ...params: Array<string | number>): T[] {
  const db = openDatabase(join(env.home, "state", "hub.sqlite"));
  try {
    return db.all<T>(sql, ...params);
  } finally {
    db.close();
  }
}

type StepRow = { node_key: string; status: string; waiting_for: string | null; active_worker_id: number | null; worker_ids_json: string };
const steps = () => query<StepRow>("SELECT node_key, status, waiting_for, active_worker_id, worker_ids_json FROM task_graph_steps ORDER BY sort_order");
type WorkerRow = { id: number; status: string; workspace: string; branch: string | null; worktree_path: string | null; base_commit: string | null; review_json: string | null };
const workerRow = (id: number) => query<WorkerRow>("SELECT id, status, workspace, branch, worktree_path, base_commit, review_json FROM workers WHERE id = ?", id)[0];
const workerCount = () => query<{ n: number }>("SELECT count(*) AS n FROM workers")[0]!.n;

/** 起守护进程、建带项目的项目经理，跟它说一句让它的会话起来；返回发 hub 命令的函数（用项目经理的令牌）。 */
async function bootPm(dir: string) {
  env.setScript({ defaultTurn: { steps: [{ text: "收到" }] } });
  const daemon = await env.start();
  const client = await Client.login(daemon);
  const { conversationId } = await client.createPm({ name: "小林", mode: "manage_only", persona: "", folder: dir });
  await waitForStatus(client, await client.post(conversationId, "在吗"), "replied", 20_000);
  const pmPid = await firstPidOfConversation(env, client, conversationId);
  const hub = async (args: string[], stdin?: string) => {
    const r = await env.runHub(pmPid, args, stdin === undefined ? {} : { stdin });
    return { code: r.code, out: `${r.stdout}${r.stderr}`.trim() };
  };
  return { hub };
}

const graphSpec = (title: string, stepsSpec: unknown[]) => JSON.stringify({ title, steps: stepsSpec });

describe("审查只查不修：端到端", { timeout: 60_000 }, () => {
  it("补建的单步审查图：不写被审分支建图被拒；写了 base，审查目录 detached 在被审分支上，推送被守护进程写的钩子拒绝", async () => {
    env = makeEnv();
    const { dir, origin } = repoWithOrigin();
    git(dir, "checkout", "-qb", "hub/target-pr");
    writeFileSync(join(dir, "calc.js"), "export const add = (a, b) => a + b;\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "target");
    git(dir, "push", "-q", "origin", "hub/target-pr");
    git(dir, "checkout", "-q", "main");
    const targetSha = git(origin, "rev-parse", "refs/heads/hub/target-pr");
    const { hub } = await bootPm(dir);
    const reviewStep = { key: "review", title: "独立审查", brief: "审查 hub/target-pr", review: true };

    const noTarget = await hub(["graph", "create", "--stdin"], graphSpec("补建独立审查", [reviewStep]));
    expect(noTarget.code).toBe(1);
    expect(noTarget.out).toContain("定不下被审分支");
    expect(workerCount()).toBe(0);
    const created = await hub(["graph", "create", "--stdin"], graphSpec("补建独立审查", [{ ...reviewStep, base: "hub/target-pr" }]));
    expect(created.code).toBe(0);

    const w = await waitUntil("审查目录建好、记下被审提交", () => {
      const row = workerRow(1);
      return row?.base_commit != null && JSON.parse(row.review_json ?? "{}").snapshot != null ? row : undefined;
    }, 30_000);
    expect(w).toMatchObject({ workspace: "worktree", branch: null, base_commit: targetSha });
    expect(JSON.parse(w.review_json!)).toMatchObject({ branch: "hub/target-pr", snapshot: { sha: targetSha, remote: { sha: targetSha } } });
    expect(git(w.worktree_path!, "rev-parse", "HEAD")).toBe(targetSha);

    const sessionId = query<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = 1")[0]!.id;
    const hooksDir = join(sessionLaunchDir(join(env.home, "state", "launch"), sessionId), REVIEW_HOOKS_DIR);
    await waitUntil("启动准备写好钩子", () => (existsSync(join(hooksDir, "pre-push")) ? true : undefined), 30_000);
    writeFileSync(join(w.worktree_path!, "calc.js"), "// reviewer direct fix\n");
    git(w.worktree_path!, "commit", "-qam", "reviewer direct fix");
    const push = spawnSync("git", ["push", "origin", "HEAD:refs/heads/hub/target-pr"], {
      cwd: w.worktree_path!,
      encoding: "utf8",
      env: { ...gitEnv, ...reviewPushGuardEnv(hooksDir, {}) },
    });
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain("审查步骤只查不修：不能推送");
    expect(git(origin, "rev-parse", "refs/heads/hub/target-pr")).toBe(targetSha);
    expect(git(dir, "rev-parse", "refs/heads/hub/target-pr")).toBe(targetSha);
    expect(steps()[0]!.status).not.toBe("done");
  });

  it("单线 impl -> review：项目经理用 --no-worktree 派审查步骤被拒，原审查 Worker 不动", async () => {
    env = makeEnv();
    const { dir } = repoWithOrigin();
    const { hub } = await bootPm(dir);
    expect((await hub(["graph", "create", "--stdin"], graphSpec("实现加审查", [{ key: "impl", title: "实现" }, { key: "review", title: "独立审查", brief: "看边界", review: true }]))).code).toBe(0);
    expect((await hub(["worker", "start", "--node", "impl", "--stdin"], "加 calc.js")).code).toBe(0);
    await waitUntil("实现的 worktree 建好", () => workerRow(1)?.base_commit ?? undefined, 30_000);
    expect((await hub(["worker", "end", "1"])).code).toBe(0);
    expect((await hub(["graph", "done", "impl"])).code).toBe(0);
    const reviewWorker = await waitUntil("审查步骤开工", () => steps()[1]?.active_worker_id ?? undefined, 30_000);
    expect(JSON.parse(workerRow(reviewWorker)!.review_json!)).toMatchObject({ branch: workerRow(1)!.branch });

    const start = await hub(["worker", "start", "--node", "review", "--no-worktree", "--stdin"], "请审查");
    expect(start.code).toBe(1);
    expect(start.out).toContain("不能用 --no-worktree");
    expect(workerCount()).toBe(2);
    expect(steps()[1]).toMatchObject({ active_worker_id: reviewWorker });
    expect(workerRow(reviewWorker)!.status).toBe("open");
  });

  it("上一步在主文件夹里干的：审查步骤不开工，停在等项目经理处理并写明找不到被审分支", async () => {
    env = makeEnv();
    const { dir } = repoWithOrigin();
    const { hub } = await bootPm(dir);
    expect((await hub(["graph", "create", "--stdin"], graphSpec("主文件夹实现", [{ key: "impl", title: "实现" }, { key: "review", title: "独立审查", brief: "看边界", review: true }]))).code).toBe(0);
    expect((await hub(["worker", "start", "--node", "impl", "--no-worktree", "--stdin"], "加 calc.js")).code).toBe(0);
    expect((await hub(["worker", "end", "1"])).code).toBe(0);
    const done = await hub(["graph", "done", "impl"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain("找不到被审分支");
    expect(steps()[1]).toMatchObject({ status: "waiting", waiting_for: "pm", worker_ids_json: "[]" });
    expect(workerCount()).toBe(1);
    const bind = await hub(["worker", "start", "--node", "review", "--stdin"], "请审查");
    expect(bind.code).toBe(1);
    expect(bind.out).toContain("找不到被审分支");
  });
});
