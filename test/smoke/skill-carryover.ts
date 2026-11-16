// 换代带上加载过的技能的真机冒烟（手动跑：node test/smoke/skill-carryover.ts [厂商…]，不进默认 vitest；docs/skill-carryover-design.md 的验收方法）。
// 照 auto-renew.ts：临时数据目录，门槛调到 1 token（只从 startDaemon 的 autoRenew 传，默认值不改），每家一个项目经理：
// 1. 它的工作目录里放两个测试技能，正文里各写一个暗号：carry-user（用户手打 /carry-user）、carry-model（让模型自己读 SKILL.md）；
// 2. 空闲后自动换到第 2 代：开场说明里“上一个会话加载过的技能”那一节带着两个暗号，问新会话答得出来；
// 3. 第 2 代没再加载，再换到第 3 代：两个技能还在（传下去）；
// 4. 删掉 carry-model 再换到第 4 代：那一节写着“文件已经没有了”。
// 每一代开场里那一节打印出来，贴进 PR。跑完删掉临时目录和这次在各家用户目录里留下的会话记录。
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { LOADED_SKILLS_HEADING } from "../../src/daemon/ledger/loaded-skills.ts";
import { PARENT_SESSION_ENV } from "../../src/daemon/driver/protocol.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { AGENT_VENDORS, API_PATHS, ENV_HOME, ENV_PORT, isHandoverTraffic, type AgentVendor } from "../../src/shared/index.ts";
import { Client, messagesOf, waitForStatus, waitUntil } from "../e2e/harness.ts";
import { MODEL, expect, removeOwnClaudeProjects, removeOwnVendorRecords, scenario, type Outcome } from "./kit.ts";

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

const env: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) if (!PARENT_SESSION_ENV.includes(k)) env[k] = v;
env[ENV_HOME] = home;
env[ENV_PORT] = "0";
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

const sectionOf = (preamble: string | null): string => {
  if (preamble === null) return "";
  const at = preamble.indexOf(LOADED_SKILLS_HEADING);
  if (at === -1) return "";
  const end = preamble.indexOf("\n## ", at + LOADED_SKILLS_HEADING.length);
  return end === -1 ? preamble.slice(at) : preamble.slice(at, end);
};

try {
  for (const vendor of vendors) {
    const ok = await scenario(outcomes, `SC ${vendor}：换代把加载过的技能正文带进新会话，隔代还在，文件没了注明`, async () => {
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
        sectionOf(query<{ preamble: string | null }>("SELECT preamble FROM handovers WHERE to_session_id = ? AND status = 'switched'", sessionId)[0]?.preamble ?? null);

      await ask("/carry-user 加载这个技能就行，只回复“好”。");
      await ask("用读文件的工具（或 cat）读一下 .agents/skills/carry-model/SKILL.md 这个技能，读完只回复“好”。");
      const loaded = query<{ name: string; source: string }>("SELECT name, source FROM loaded_skills WHERE conversation_id = ? ORDER BY name", chat);
      expect(loaded.length === 2, `第 1 代记下的技能不对：${JSON.stringify(loaded)}`);

      const g2 = await sessionOf(2);
      const s2 = sectionFor(g2.sessionId);
      console.log(`\n----- ${vendor} 第 2 代开场里的技能一节 -----\n${s2}\n-----`);
      expect(s2.includes(userSecret) && s2.includes(modelSecret), "第 2 代开场里没带上两个技能的正文");

      const q = await ask("carry-user 和 carry-model 这两个技能里的暗号各是什么？只回复两个暗号，用空格隔开。");
      const replies = messagesOf(await client.state(), chat)
        .filter((m) => m.id > q && m.sender === "agent" && m.kind === "text" && !isHandoverTraffic(m))
        .map((m) => m.text)
        .join("\n");
      expect(replies.includes(userSecret) && replies.includes(modelSecret), `新会话答不出暗号：${replies}`);

      const g3 = await sessionOf(3);
      const s3 = sectionFor(g3.sessionId);
      console.log(`\n----- ${vendor} 第 3 代开场里的技能一节（第 2 代没再加载）-----\n${s3.slice(0, 600)}\n-----`);
      expect(s3.includes(userSecret) && s3.includes(modelSecret), "第 3 代开场里技能丢了");

      rmSync(join(cwd, ".agents", "skills", "carry-model"), { recursive: true, force: true });
      await ask("只回复“好”。");
      const g4 = await sessionOf(4);
      const s4 = sectionFor(g4.sessionId);
      console.log(`\n----- ${vendor} 第 4 代开场里的技能一节（删了 carry-model）-----\n${s4.slice(0, 600)}\n-----`);
      expect(s4.includes(userSecret) && !s4.includes(modelSecret) && /文件已经没有了：carry-model/.test(s4), "第 4 代没注明 carry-model 文件没了");
      return `${model}：第 1 代记下 ${loaded.map((r) => `${r.name}(${r.source})`).join("、")}；第 2、3 代都带上，第 4 代注明文件没了；新会话答出“${replies.trim()}”`;
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
