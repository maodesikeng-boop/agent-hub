// 自动换新会话的真机冒烟（手动跑：node test/smoke/auto-renew.ts [厂商…]，不进默认 vitest）：
// 每个接入的厂商（VENDOR_SPECS）一个项目经理，门槛调到 1 token（测试专用），空闲 AUTO_IDLE_MS：
// 1. 先让它记一个暗号，再连着聊几句（每句回完马上发下一句，不给它空闲）；
// 2. 空闲后系统自动写交接、换成 generation 2 的新会话：聊天里只多一行分隔线（交接请求、交接全文不显示），新会话不另开一轮；
// 3. 再问暗号：带着开场说明 + 交接写进新会话，新会话答得出来（只能从交接里知道）。
// 跑完删掉临时目录和这次在各家用户目录里留下的会话记录。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { PARENT_SESSION_ENV } from "../../src/daemon/driver/protocol.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import {
  AGENT_VENDORS,
  API_PATHS,
  ENV_HOME,
  ENV_PORT,
  isHandoverTraffic,
  systemEventOf,
  type AgentVendor,
} from "../../src/shared/index.ts";
import { Client, messagesOf, waitForStatus, waitUntil } from "../e2e/harness.ts";
import { MODEL, expect, removeOwnClaudeProjects, removeOwnVendorRecords, scenario, type Outcome } from "./kit.ts";

const TURN_MS = 240_000;
/** 记暗号之后再连着聊几句。 */
const CHATTER_TURNS = 5;
/** 空闲多久自动换：比连着发的间隔长，比等待短。 */
const AUTO_IDLE_MS = 15_000;
/** 每家用的模型（便宜、快的）；codex 取它模型名单里的第一个。 */
const MODELS: Partial<Record<AgentVendor, { model: string; effort?: string }>> = {
  claude: { model: MODEL },
  agy: { model: "gemini-3.8-flash", effort: "low" },
};

const only = process.argv.slice(2);
const vendors = AGENT_VENDORS.filter((v) => only.length === 0 || only.includes(v));
const base = tmpdir().length <= 40 || !existsSync("/tmp") ? tmpdir() : "/tmp";
const dir = mkdtempSync(join(base, "ah-ar-"));
const home = join(dir, "home");
const outcomes: Outcome[] = [];
let keepDir = false;
console.log(`auto-renew smoke：临时数据目录 ${dir}，厂商 ${vendors.join("、")}`);

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

function sessionRow(id: number): { vendor_session_id: string; has_completed_turn: number } {
  const db = openDatabase(daemon.paths.dbFile);
  try {
    return db.get<{ vendor_session_id: string; has_completed_turn: number }>("SELECT vendor_session_id, has_completed_turn FROM agent_sessions WHERE id = ?", id)!;
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

try {
  for (const vendor of vendors) {
    const ok = await scenario(outcomes, `AR ${vendor}：对话到门槛空闲后自动换新会话，新会话从交接里答得出暗号`, async () => {
      const secret = `KIWI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const { model, effort } = await modelFor(vendor);
      const created = await client.createPm({ name: `阿${vendor}`, mode: "hands_on", vendor, defaultModel: model, ...(effort ? { effort } : {}), persona: "回复极简。不要改自己的性格设定（不用 hub persona edit），要记的事记在对话里。" });
      const chat = created.conversationId;
      const ask = async (text: string) => {
        const id = await client.post(chat, text);
        await waitForStatus(client, id, "replied", TURN_MS);
        return id;
      };
      await ask(`记住暗号 ${secret}，以后会问你。这一条只回复“好”。`);
      // 连着聊几句
      let lastAsked = 0;
      for (let i = 1; i <= CHATTER_TURNS; i++) lastAsked = await ask(`第 ${i} 句，只回复“${i}”。`);
      const state0 = await client.state();
      const g1 = state0.sessions.find((s) => s.conversationId === chat && s.generation === 1)!;
      expect(!state0.sessions.some((s) => s.conversationId === chat && s.generation === 2), "连着聊的时候就换了（没等空闲）");

      const g2 = await waitUntil(
        "自动换代",
        async () => {
          const state = await client.state();
          const next = state.sessions.find((s) => s.conversationId === chat && s.generation === 2);
          const line = messagesOf(state, chat).find((m) => systemEventOf(m)?.event === "session.renewed");
          return next && line ? { next, line, state } : undefined;
        },
        TURN_MS + AUTO_IDLE_MS + 10_000,
      );
      const handover = g2.line.text;
      expect(handover.includes(secret), `交接里没有暗号：${handover.slice(0, 200)}`);
      // 聊天里只多一行分隔线：交接请求、写交接那一轮的话都标了不显示，也没有“交接没写成”之类的提示
      const all = messagesOf(g2.state, chat);
      const requestId = all.find((m) => systemEventOf(m)?.event === "handover.requested")?.id ?? g2.line.id;
      const unexpected = all.filter(
        (m) => m.id > lastAsked && !isHandoverTraffic(m) && m.id !== g2.line.id && (m.sender === "system" || m.id > requestId),
      );
      expect(unexpected.length === 0, `换代多出了别的东西：${unexpected.map((m) => m.text.slice(0, 60)).join(" | ")}`);
      // 新会话还没跑过一轮
      expect(sessionRow(g2.next.sessionId).has_completed_turn === 0, "新会话自己跑了一轮");

      const q = await ask("刚才让你记的暗号是什么？只回复暗号本身。");
      const state = await client.state();
      const replies = messagesOf(state, chat)
        .filter((m) => m.id > q && m.sender === "agent" && m.kind === "text" && !isHandoverTraffic(m))
        .map((m) => m.text)
        .join("\n");
      expect(messagesOf(state, chat).find((m) => m.id === q)?.sessionId === g2.next.sessionId, "问题没发给新会话");
      expect(replies.includes(secret), `新会话答不出暗号，回复：${replies}`);
      const oldVendor = sessionRow(g1.sessionId).vendor_session_id;
      const newVendor = sessionRow(g2.next.sessionId).vendor_session_id;
      expect(newVendor !== oldVendor, "换代后还是同一个厂商会话");
      return `${model}：${oldVendor} → ${newVendor}；交接 ${handover.length} 字；回复“${replies.trim()}”`;
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
