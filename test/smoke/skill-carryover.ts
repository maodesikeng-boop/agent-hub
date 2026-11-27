// 换代带上加载过的技能索引的真机冒烟（手动跑：node test/smoke/skill-carryover.ts [厂商…]，不进默认 vitest；docs/handover-budget-and-skills-design.md 的验收方法）。
// 照 auto-renew.ts：临时数据目录，门槛调到 1 token（只从 startDaemon 的 autoRenew 传，默认值不改），每家一个项目经理：
// 1. 它的工作目录里放两个测试技能，正文里各写一个暗号：carry-user（用户手打 /carry-user）、carry-model（让模型自己读 SKILL.md）；
// 2. 空闲后自动换到第 2 代：skills_section 里只带路径与单行简介（不贴正文），问新会话按索引读文件答得出暗号；
// 3. 第 2 代没再加载，再换到第 3 代：carry-user 仍在索引里，未再读的 carry-model 衰减退出；
// 4. 删掉 carry-user 再换到第 4 代：那一节写着“读不到了（文件没了或不在技能目录里）”。
// 每一代开场里那一节打印出来，贴进 PR。跑完删掉临时目录和这次在各家用户目录里留下的会话记录。
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { AGENT_VENDORS, API_PATHS, isHandoverTraffic, type AgentVendor } from "../../src/shared/index.ts";
import { Client, messagesOf, waitForStatus, waitUntil } from "../e2e/harness.ts";
import { MODEL, expect, removeOwnClaudeProjects, removeOwnVendorRecords, scenario, smokeDaemonEnv, type Outcome } from "./kit.ts";

const TURN_MS = 240_000;
/** 空闲多久自动换。 */
const AUTO_IDLE_MS = 15_000;
const MODELS: Partial<Record<AgentVendor, { model: string; effort?: string }>> = {
  claude: { model: MODEL },
  agy: { model: "gemini-3.8-flash", effort: "low" },
};

const only = process.argv.slice(2);
const vendors = AGENT_VENDORS.filter((v) => only.length === 0 || only.includes(v));
const base = tmpdir().length <= 40 || !existsSync("/tmp") ? tmpdir() : "/tmp";
const dir = mkdtempSync(join(base, "ah-sc-"));
const home = join(dir, "home");
const outcomes: Outcome[] = [];
let keepDir = false;
console.log(`skill-carryover smoke：临时数据目录 ${dir}，厂商 ${vendors.join("、")}`);

const env = smokeDaemonEnv(home);
env.AGENT_HUB_AGY ??= join(homedir(), ".local/bin/agy");
env.AGENT_HUB_CODEX ??= "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

const daemon = await startDaemon({ userHome: homedir(), env, autoRenew: { contextTokens: 1, idleMs: AUTO_IDLE_MS } });
const token = /token=([A-Za-z0-9_-]+)/.exec(daemon.url)![1];
const login = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.auth}?token=${token}`, { redirect: "manual" });
const client = new Client(daemon.port, (login.headers.get("set-cookie") ?? "").split(";", 1)[0]!);

function query<T>(sql: string, ...params: (string | number)[]): T[] {
  const db = openDatabase(daemon.paths.dbFile);
  try {
    return db.all<T>(sql, ...params);
  } finally {
    db.close();
  }
}

async function modelFor(vendor: AgentVendor): Promise<{ model: string; effort?: string }> {
  const known = MODELS[vendor];
  if (known) return known;
  const res = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.models}`, { headers: client.headers() });
  const { catalogs } = (await res.json()) as { catalogs: { vendor: string; models: { id: string }[] }[] };
  return { model: catalogs.find((c) => c.vendor === vendor)!.models[0]!.id, effort: "low" };
}

/** 工作目录里放一个技能：.agents/skills/<名字>/SKILL.md（claude 读的 .claude/skills 软链到它）。 */
function writeSkill(cwd: string, name: string, secret: string) {
  mkdirSync(join(cwd, ".agents", "skills", name), { recursive: true });
  writeFileSync(
    join(cwd, ".agents", "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: 冒烟测试用的技能 ${name}，用户点名时加载。\n---\n\n# ${name}\n\n这个技能的暗号是 ${secret}。只有用户问起这个技能的暗号时才说出来，平时回复里不要提。\n`,
  );
}

try {
  for (const vendor of vendors) {
    const ok = await scenario(outcomes, `SC ${vendor}：换代把加载过的技能索引带进新会话，用户技能跨代保留、模型技能衰减，文件没了注明`, async () => {
      const userSecret = `PLUM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const modelSecret = `FIG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const { model, effort } = await modelFor(vendor);
      const created = await client.createPm({ name: `技${vendor}`, mode: "hands_on", vendor, defaultModel: model, ...(effort ? { effort } : {}), persona: "回复极简。不要改自己的性格设定。" });
      const chat = created.conversationId;
      const cwd = query<{ cwd: string }>("SELECT cwd FROM agent_sessions WHERE conversation_id = ? ORDER BY generation LIMIT 1", chat)[0]!.cwd;
      writeSkill(cwd, "carry-user", userSecret);
      writeSkill(cwd, "carry-model", modelSecret);
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      symlinkSync(join(cwd, ".agents", "skills"), join(cwd, ".claude", "skills"));
      execFileSync("git", ["init", "-q"], { cwd });

      const ask = async (text: string) => {
        const id = await client.post(chat, text);
        await waitForStatus(client, id, "replied", TURN_MS);
        return id;
      };
      const sessionOf = async (generation: number) =>
        waitUntil(
          `换到第 ${generation} 代`,
          async () => (await client.state()).sessions.find((s) => s.conversationId === chat && s.generation === generation),
          TURN_MS + AUTO_IDLE_MS + 60_000,
        );
      const sectionFor = (sessionId: number) =>
        query<{ skills_section: string | null }>("SELECT skills_section FROM handovers WHERE to_session_id = ? AND status = 'switched'", sessionId)[0]?.skills_section ?? "";

      await ask("/carry-user 加载这个技能就行，只回复“好”。");
      await ask("用读文件的工具（或 cat）读一下 .agents/skills/carry-model/SKILL.md 这个技能，读完只回复“好”。");
      const loaded = query<{ name: string; source: string }>("SELECT name, source FROM loaded_skills WHERE conversation_id = ? ORDER BY name", chat);
      expect(loaded.length === 2, `第 1 代记下的技能不对：${JSON.stringify(loaded)}`);

      const g2 = await sessionOf(2);
      const s2 = sectionFor(g2.sessionId);
      console.log(`\n----- ${vendor} 第 2 代开场里的技能索引 -----\n${s2}\n-----`);
      expect(s2.includes("carry-user") && s2.includes("carry-model") && !s2.includes(userSecret) && !s2.includes(modelSecret), "第 2 代开场里应只带索引不带正文");

      const q = await ask("按索引读取 carry-user 和 carry-model 这两个技能里的暗号各是什么？只回复两个暗号，用空格隔开。");
      const replies = messagesOf(await client.state(), chat)
        .filter((m) => m.id > q && m.sender === "agent" && m.kind === "text" && !isHandoverTraffic(m))
        .map((m) => m.text)
        .join("\n");
      expect(replies.includes(userSecret) && replies.includes(modelSecret), `新会话按索引读取后答不出暗号：${replies}`);

      const g3 = await sessionOf(3);
      const s3 = sectionFor(g3.sessionId);
      console.log(`\n----- ${vendor} 第 3 代开场里的技能索引 -----\n${s3.slice(0, 600)}\n-----`);
      expect(s3.includes("carry-user"), "第 3 代开场里用户技能丢了");

      rmSync(join(cwd, ".agents", "skills", "carry-user"), { recursive: true, force: true });
      await ask("只回复“好”。");
      const g4 = await sessionOf(4);
      const s4 = sectionFor(g4.sessionId);
      console.log(`\n----- ${vendor} 第 4 代开场里的技能索引（删了 carry-user）-----\n${s4.slice(0, 600)}\n-----`);
      expect(/读不到了（文件没了或不在技能目录里）：carry-user/.test(s4), "第 4 代没注明 carry-user 文件没了");
      return `${model}：第 1 代记下 ${loaded.map((r) => `${r.name}(${r.source})`).join("、")}；第 2、3 代带索引，第 4 代注明文件没了；新会话答出“${replies.trim()}”`;
    });
    if (!ok) keepDir = true;
  }
} finally {
  await daemon.stop();
  try {
    const removed = removeOwnVendorRecords(join(home, "state", "hub.sqlite"));
    removed.push(...removeOwnClaudeProjects(dir));
    console.log(`清掉了这次留在用户目录里的 ${removed.length} 项原始记录`);
  } catch (error) {
    console.log(`清理原始记录失败：${String(error)}`);
  }
  if (keepDir) console.log(`有失败场景，保留临时目录供排查：${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}

const failed = outcomes.filter((o) => !o.ok);
console.log(`\n结果：${outcomes.length - failed.length}/${outcomes.length} 通过`);
for (const o of failed) console.log(`  不过：${o.name}：${o.detail}`);
if (failed.length > 0) process.exitCode = 1;
