// 多厂商真机冒烟测试（手动/冒烟运行：node test/smoke/multi-vendor.ts，不进默认 vitest 单测）：
// 1. 在临时目录启动真 startDaemon（验证 resolveExecutable 自动发现本机 agy 与 codex）；
// 2. 建一个 agy 项目经理，发消息让它跑 `hub status` 并简短回复，验证真 agy 进程启动、init 更新 vendorSessionId、
//    hub status 通过 Unix socket 调通、流式文字和 turn.ended 完整落库；
// 3. 建一个 codex 项目经理，发消息让它跑 `hub status` 并简短回复，验证真 codex app-server 握手、thread/start、turn/start、
//    hub status 通过 Unix socket（含 shell_environment_policy.set 注入的 HUB_TOKEN/HUB_SOCK）调通、turn/completed 完整落库；
// 4. 再各建一个 pi（RPC）和 cursor（ACP 常驻）项目经理，同样跑 `hub status` 并回复落库；
// 5. 干净关机（daemon.stop()），确认无残留进程。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../src/daemon/daemon.ts";
import { PARENT_SESSION_ENV } from "../../src/daemon/driver/protocol.ts";
import { openDatabase } from "../../src/daemon/store/index.ts";
import { API_PATHS, ENV_HOME, ENV_PORT, HUB_COMMAND } from "../../src/shared/index.ts";
import { Client, agentTexts, isAlive, messagesOf, waitForStatus } from "../e2e/harness.ts";
import { expect, psLines, removeOwnClaudeProjects, removeOwnVendorRecords, scenario, type Outcome } from "./kit.ts";

const TURN_TIMEOUT_MS = 180_000;

function shortTmp(): string {
  const base = tmpdir();
  return base.length <= 40 || !existsSync("/tmp") ? base : "/tmp";
}

interface SessionDbRow {
  id: number;
  vendor: string;
  vendor_session_id: string;
  pid: number | null;
  status: string;
  has_completed_turn: number;
}

function readSessionRow(dbFile: string, sessionId: number): SessionDbRow {
  const db = openDatabase(dbFile);
  try {
    const rows = db.all<SessionDbRow>("SELECT id, vendor, vendor_session_id, pid, status, has_completed_turn FROM agent_sessions WHERE id = ?", sessionId);
    if (!rows[0]) throw new Error(`agent_sessions 中找不到 session ${sessionId}`);
    return rows[0];
  } finally {
    db.close();
  }
}

const dir = mkdtempSync(join(shortTmp(), "ah-mv-"));
const home = join(dir, "home");
const outcomes: Outcome[] = [];
let keepDir = false;

console.log(`multi-vendor smoke：临时数据目录 ${dir}`);

const cleanEnv: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!PARENT_SESSION_ENV.includes(k)) cleanEnv[k] = v;
}
cleanEnv[ENV_HOME] = home;
cleanEnv[ENV_PORT] = "0";

const daemon = await startDaemon({
  userHome: homedir(),
  env: cleanEnv,
});

const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(daemon.url);
if (!tokenMatch) throw new Error(`无法从登录 URL 解析 token：${daemon.url}`);

const loginRes = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.auth}?token=${tokenMatch[1]}`, { redirect: "manual" });
if (loginRes.status !== 302) throw new Error(`登录失败：${loginRes.status}`);
const cookie = (loginRes.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
const client = new Client(daemon.port, cookie);

const trackedPids = new Set<number>();
const trackedVendorIds = new Set<string>();

try {
  // 场景 1：真 agy 项目经理
  const agyOk = await scenario(outcomes, "MV1 真 agy 项目经理：启动、init 更新会话 ID、跑 hub status 并回复落库", async () => {
    const created = await client.createPm({
      name: "阿吉",
      mode: "hands_on",
      vendor: "agy",
      defaultModel: "gemini-3.8-flash",
      effort: "low",
      persona: "你是阿吉，回复极简。",
    });
    const chatId = created.conversationId;
    const stateBefore = await client.state();
    const sessionBefore = stateBefore.sessions.find((s) => s.conversationId === chatId);
    expect(sessionBefore !== undefined, "找不到 agy PM 的会话");

    const prompt = `在终端运行 \`${HUB_COMMAND} status\`，然后用一句话回复你在输出里看到的项目经理名字（必须包含“阿吉”）。`;
    const msgId = await client.post(chatId, prompt);
    await waitForStatus(client, msgId, "replied", TURN_TIMEOUT_MS);

    const stateAfter = await client.state();
    const msgs = messagesOf(stateAfter, chatId);
    const tools = msgs.filter((m) => m.id > msgId && m.sender === "agent" && m.kind === "tool");
    const replies = agentTexts(stateAfter, chatId);
    const combinedReply = replies.join("\n");

    const row = readSessionRow(daemon.paths.dbFile, sessionBefore.sessionId);
    if (row.pid !== null) trackedPids.add(row.pid);
    if (row.vendor_session_id) trackedVendorIds.add(row.vendor_session_id);

    expect(row.vendor === "agy", `vendor 应为 agy，实际为 ${row.vendor}`);
    expect(row.vendor_session_id.trim() !== "", "vendor_session_id 为空");
    expect(row.has_completed_turn === 1, `has_completed_turn 应为 1，实际为 ${row.has_completed_turn}`);
    expect(tools.length > 0, "未记录到 agy 的工具调用");
    expect(combinedReply.includes("阿吉"), `回复中未包含“阿吉”：${combinedReply}`);

    return `sessionId=${row.id}，vendorSessionId=${row.vendor_session_id}，工具 ${tools.length} 次，回复：“${combinedReply.trim().slice(0, 80)}”`;
  });
  if (!agyOk) keepDir = true;

  // 场景 2：真 codex 项目经理
  const codexOk = await scenario(outcomes, "MV2 真 codex 项目经理：app-server 握手、跑 hub status 并回复落库", async () => {
    const modelsRes = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.models}`, {
      headers: { Cookie: cookie },
    });
    expect(modelsRes.status === 200, `GET /api/models 状态码异常：${modelsRes.status}`);
    const { catalogs } = (await modelsRes.json()) as { catalogs: { vendor: string; source: string; models: { id: string }[] }[] };
    const codexCatalog = catalogs.find((c) => c.vendor === "codex");
    expect(codexCatalog !== undefined && codexCatalog.models.length > 0, "未拿到 codex 模型名单");
    const codexModel = codexCatalog.models[0]!.id;

    const created = await client.createPm({
      name: "小科",
      mode: "hands_on",
      vendor: "codex",
      defaultModel: codexModel,
      effort: "low",
      persona: "你是小科，回复极简。",
    });
    const chatId = created.conversationId;
    const stateBefore = await client.state();
    const sessionBefore = stateBefore.sessions.find((s) => s.conversationId === chatId);
    expect(sessionBefore !== undefined, "找不到 codex PM 的会话");

    const prompt = `请在 shell 中运行 \`${HUB_COMMAND} status\`，然后只用一句话回复你在输出里看到的项目经理名字（必须包含“小科”）。`;
    const msgId = await client.post(chatId, prompt);
    await waitForStatus(client, msgId, "replied", TURN_TIMEOUT_MS);

    const stateAfter = await client.state();
    const msgs = messagesOf(stateAfter, chatId);
    const tools = msgs.filter((m) => m.id > msgId && m.sender === "agent" && m.kind === "tool");
    const replies = agentTexts(stateAfter, chatId);
    const combinedReply = replies.join("\n");

    const row = readSessionRow(daemon.paths.dbFile, sessionBefore.sessionId);
    if (row.pid !== null) trackedPids.add(row.pid);
    if (row.vendor_session_id) trackedVendorIds.add(row.vendor_session_id);

    expect(row.vendor === "codex", `vendor 应为 codex，实际为 ${row.vendor}`);
    expect(row.vendor_session_id.trim() !== "", "vendor_session_id 为空");
    expect(row.has_completed_turn === 1, `has_completed_turn 应为 1，实际为 ${row.has_completed_turn}`);
    expect(tools.length > 0, "未记录到 codex 的工具调用");
    expect(combinedReply.includes("小科"), `回复中未包含“小科”：${combinedReply}`);

    return `sessionId=${row.id}，threadId=${row.vendor_session_id}，工具 ${tools.length} 次，回复：“${combinedReply.trim().slice(0, 80)}”`;
  });
  if (!codexOk) keepDir = true;

  // 场景 3：真 pi 项目经理
  const piOk = await scenario(outcomes, "MV3 真 pi 项目经理：RPC 握手、跑 hub status 并回复落库", async () => {
    const piModel = process.env.AGENT_HUB_PI_MODEL || "deepseek/deepseek-flash";
    const created = await client.createPm({
      name: "小派",
      mode: "hands_on",
      vendor: "pi",
      defaultModel: piModel,
      effort: "low",
      persona: "你是小派，回复极简。",
    });
    const chatId = created.conversationId;
    const stateBefore = await client.state();
    const sessionBefore = stateBefore.sessions.find((s) => s.conversationId === chatId);
    expect(sessionBefore !== undefined, "找不到 pi PM 的会话");

    const prompt = `请在 shell 中运行 \`${HUB_COMMAND} status\`，然后只用一句话回复你在输出里看到的项目经理名字（必须包含“小派”）。`;
    const msgId = await client.post(chatId, prompt);
    await waitForStatus(client, msgId, "replied", TURN_TIMEOUT_MS);

    const stateAfter = await client.state();
    const msgs = messagesOf(stateAfter, chatId);
    const tools = msgs.filter((m) => m.id > msgId && m.sender === "agent" && m.kind === "tool");
    const replies = agentTexts(stateAfter, chatId);
    const combinedReply = replies.join("\n");

    const row = readSessionRow(daemon.paths.dbFile, sessionBefore.sessionId);
    if (row.pid !== null) trackedPids.add(row.pid);
    if (row.vendor_session_id) trackedVendorIds.add(row.vendor_session_id);

    expect(row.vendor === "pi", `vendor 应为 pi，实际为 ${row.vendor}`);
    expect(row.vendor_session_id.trim() !== "", "vendor_session_id 为空");
    expect(row.has_completed_turn === 1, `has_completed_turn 应为 1，实际为 ${row.has_completed_turn}`);
    expect(tools.length > 0, "未记录到 pi 的工具调用");
    expect(combinedReply.includes("小派"), `回复中未包含“小派”：${combinedReply}`);

    return `sessionId=${row.id}，vendorSessionId=${row.vendor_session_id}，工具 ${tools.length} 次，回复：“${combinedReply.trim().slice(0, 80)}”`;
  });
  if (!piOk) keepDir = true;

  // 场景 4：真 cursor 项目经理
  const cursorOk = await scenario(outcomes, "MV4 真 cursor 项目经理：ACP 常驻握手、跑 hub status 并回复落库", async () => {
    const modelsRes = await fetch(`http://127.0.0.1:${daemon.port}${API_PATHS.models}`, {
      headers: { Cookie: cookie },
    });
    expect(modelsRes.status === 200, `GET /api/models 状态码异常：${modelsRes.status}`);
    const { catalogs } = (await modelsRes.json()) as { catalogs: { vendor: string; source: string; models: { id: string }[] }[] };
    const cursorCatalog = catalogs.find((c) => c.vendor === "cursor");
    expect(cursorCatalog !== undefined && cursorCatalog.models.length > 0, "未拿到 cursor 模型名单");
    const cursorModel = process.env.AGENT_HUB_CURSOR_MODEL || cursorCatalog.models.find((m) => m.id === "composer-2.5-fast")?.id || cursorCatalog.models[0]!.id;

    const created = await client.createPm({
      name: "小游",
      mode: "hands_on",
      vendor: "cursor",
      defaultModel: cursorModel,
      effort: null,
      persona: "你是小游，回复极简。",
    });
    const chatId = created.conversationId;
    const stateBefore = await client.state();
    const sessionBefore = stateBefore.sessions.find((s) => s.conversationId === chatId);
    expect(sessionBefore !== undefined, "找不到 cursor PM 的会话");

    const prompt = `请在终端运行 \`${HUB_COMMAND} status\`，然后只用一句话回复你在输出里看到的项目经理名字（必须包含“小游”）。`;
    const msgId = await client.post(chatId, prompt);
    await waitForStatus(client, msgId, "replied", TURN_TIMEOUT_MS);

    const stateAfter = await client.state();
    const msgs = messagesOf(stateAfter, chatId);
    const tools = msgs.filter((m) => m.id > msgId && m.sender === "agent" && m.kind === "tool");
    const replies = agentTexts(stateAfter, chatId);
    const combinedReply = replies.join("\n");

    const row = readSessionRow(daemon.paths.dbFile, sessionBefore.sessionId);
    if (row.pid !== null) trackedPids.add(row.pid);
    if (row.vendor_session_id) trackedVendorIds.add(row.vendor_session_id);

    expect(row.vendor === "cursor", `vendor 应为 cursor，实际为 ${row.vendor}`);
    expect(row.vendor_session_id.trim() !== "", "vendor_session_id 为空");
    expect(row.has_completed_turn === 1, `has_completed_turn 应为 1，实际为 ${row.has_completed_turn}`);
    expect(tools.length > 0, "未记录到 cursor 的工具调用");
    expect(combinedReply.includes("小游"), `回复中未包含“小游”：${combinedReply}`);

    return `sessionId=${row.id}，acpSessionId=${row.vendor_session_id}，工具 ${tools.length} 次，回复：“${combinedReply.trim().slice(0, 80)}”`;
  });
  if (!cursorOk) keepDir = true;
} finally {
  const stopOk = await scenario(outcomes, "MV5 干净关机：daemon.stop() 无残留进程", async () => {
    await daemon.stop();
    const alivePids = [...trackedPids].filter(isAlive);
    const lines = psLines();
    const lingeringVendor = [...trackedVendorIds].flatMap((id) => lines.filter((l) => l.includes(id)));
    expect(alivePids.length === 0, `关机后仍有存活 pid：${alivePids.join(", ")}`);
    expect(lingeringVendor.length === 0, `关机后仍有残留会话进程：${lingeringVendor.join(" | ")}`);
    return `已停止守护进程，检查了 ${trackedPids.size} 个 pid 与 ${trackedVendorIds.size} 个会话 ID 均无残留`;
  });
  if (!stopOk) keepDir = true;

  // codex、agy 起会话时没法不存记录：关机后（进程都没了）删掉这次会话在用户目录里留的那几份，只删账本里这次的会话 ID 对应的
  try {
    const removed = removeOwnVendorRecords(join(home, "state", "hub.sqlite"));
    removed.push(...removeOwnClaudeProjects(dir));
    console.log(`清掉了这次留在用户目录里的 ${removed.length} 项原始记录`);
  } catch (error) {
    console.log(`清理原始记录失败（请手动查 ~/.codex/sessions、~/.gemini/antigravity-cli/conversations）：${String(error)}`);
  }

  if (keepDir) {
    console.log(`有失败场景，保留临时目录供排查：${dir}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failed = outcomes.filter((o) => !o.ok);
console.log(`\n结果：${outcomes.length - failed.length}/${outcomes.length} 通过`);
for (const o of failed) console.log(`  不过：${o.name}：${o.detail}`);
if (failed.length > 0) process.exitCode = 1;
