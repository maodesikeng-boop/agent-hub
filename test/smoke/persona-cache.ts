// 改性格设定后的缓存命中（S29）：项目经理先聊两句把缓存焐热，资料页改性格设定，再发一条，看这一条第一次请求的 token：
// 改之前是重启会话（系统提示词变了，整段缓存失效）；改之后不重启，说明追加在后面，前面整段照样命中缓存。
// 只读 claude 原始输出里的 usage（state/logs/sessions/<会话>.jsonl），对比数字打印出来（写进 PR）。
// 同一个脚本也能拷到老版本（main）的仓库里跑，拿重启方式的数字：不用这个 PR 新加的东西。
import { API_PATHS } from "../../src/shared/index.ts";
import { MODEL, Smoke, expect, scenario, type Outcome } from "./kit.ts";

interface Usage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

function usageOf(raw: Record<string, any> | undefined): Usage | null {
  const u = raw?.usage;
  if (!u) return null;
  return { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

const show = (u: Usage | null) => (u === null ? "（没有）" : `input ${u.input}，缓存命中 ${u.cacheRead}，写缓存 ${u.cacheWrite}`);

export async function runPersonaCache(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S29")) return;
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, "S29 资料页改性格设定：看改完后第一次请求的缓存命中", async () => {
    const { pmId, conversationId } = await smoke.client.createPm({
      name: "阿周",
      mode: "hands_on",
      defaultModel: MODEL,
      persona: "阿周：简洁、直接。",
      folder: smoke.folder("s29"),
    });
    await smoke.ask(conversationId, "第一条：只回复“好”。");
    await smoke.ask(conversationId, "第二条：只回复“好”。");
    const session = await smoke.currentSession(conversationId);
    const pidBefore = smoke.sessionRow(session.sessionId).pid;

    const res = await fetch(smoke.client.base + API_PATHS.persona(pmId), {
      method: "PUT",
      headers: smoke.client.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "阿周：简洁、直接。每条回复最后都加上 PEAR 这个词。" }),
    });
    expect(res.status === 200, `PUT persona 回 ${res.status}`);
    const { replies } = await smoke.ask(conversationId, "第三条：只回复“好”。");
    const pidAfter = smoke.sessionRow(session.sessionId).pid;

    // 每次 API 请求一条 assistant（同一次请求拆成几条的 message.id 一样，只取第一条）；按 user 回显分到第几条消息
    const log = smoke.sessionLog(session.sessionId);
    const firstCallAfter: Array<Usage | null> = [];
    let waiting = false;
    for (const e of log) {
      if (e.type === "user" && e.isReplay === true) waiting = true;
      else if (e.type === "assistant" && waiting && !e.parent_tool_use_id) {
        firstCallAfter.push(usageOf(e.message));
        waiting = false;
      }
    }
    const results = log.filter((e) => e.type === "result").map((e) => usageOf(e));
    const before = firstCallAfter[1] ?? null;
    const after = firstCallAfter[2] ?? null;
    const reply = replies.join("\n");
    const lines = [
      `进程 ${pidBefore} → ${pidAfter}（${pidBefore === pidAfter ? "没重启" : "重启了"}）`,
      `第二条第一次请求：${show(before)}`,
      `改完后第三条第一次请求：${show(after)}`,
      `三轮 result 汇总：${results.map(show).join(" / ")}`,
      `第三条的回复：${reply.replaceAll("\n", " ")}`,
    ];
    for (const l of lines) console.log(`  ${l}`);
    expect(after !== null, "没读到第三条的 usage");
    expect(/PEAR/.test(reply), `新的性格设定没生效（回复里没有 PEAR）：${reply}`);
    return lines.join("；");
  });
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: "S29（收尾）", ok: false, detail: problems.join("；") });
}
