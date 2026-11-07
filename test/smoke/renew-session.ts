// 开新会话的冒烟（S22）：和项目经理聊一句带暗号的话，资料页点“开新会话”：它写完交接后换成新的 claude 会话（新的会话 ID），
// 再问暗号，新会话从交接里答得出来。
import { API_PATHS, type RenewSessionResponse } from "../../src/shared/index.ts";
import { MODEL, Smoke, TURN_MS, expect, scenario, waitUntil, type Outcome } from "./kit.ts";

export async function runRenewSession(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S22")) return;
  const smoke = await Smoke.boot({ persist: true });
  const ok = await scenario(outcomes, "S22 开新会话：写完交接换成新的 claude 会话，新会话从交接里答得出暗号", async () => {
    const secret = `KIWI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { pmId, conversationId } = await smoke.client.createPm({
      name: "阿周",
      mode: "hands_on",
      defaultModel: MODEL,
      persona: "阿周：简洁、直接。",
      folder: smoke.folder("s22"),
    });
    await smoke.ask(conversationId, `记住暗号 ${secret}，以后会问你。这一条只回复“好”。`);
    const old = await smoke.currentSession(conversationId);
    const oldVendor = smoke.sessionRow(old.sessionId).vendorSessionId;

    const res = await fetch(smoke.client.base + API_PATHS.renewSession(pmId), { method: "POST", headers: smoke.client.headers() });
    expect(res.status === 202, `POST renew-session 回 ${res.status}`);
    const { handoverId } = (await res.json()) as RenewSessionResponse;
    // 换代：新会话不另开一轮，开场说明 + 交接拼在下一条（下面的提问）前面
    const next = await waitUntil(
      "换成新一代会话",
      async () => {
        const session = await smoke.currentSession(conversationId);
        return session.generation >= 2 ? session : undefined;
      },
      TURN_MS * 2,
    );
    const state = await smoke.client.state();
    const handover =
      state.conversations.find((c) => c.conversation.id === conversationId)!.messages.find((m) => (m.meta as { event?: string } | null)?.event === "session.renewed")
        ?.text ?? "";
    expect(handoverId > 0 && handover !== "", "换代那一行没有交接全文");
    const newVendor = smoke.sessionRow(next.sessionId).vendorSessionId;
    expect(newVendor !== oldVendor, "换代后还是同一个 claude 会话 ID");

    const { replies } = await smoke.ask(conversationId, "刚才的暗号是什么？只回复暗号本身。");
    const reply = replies.join("\n");
    expect(reply.includes(secret), `新会话答不出暗号，回复：${reply}`);
    const inits = smoke.sessionLog(next.sessionId).filter((e) => e.type === "system" && e.subtype === "init");
    expect(inits.length > 0 && inits.every((e) => e.session_id === newVendor), `新会话日志里的 session_id 不是 ${newVendor}`);
    return `旧会话 ${oldVendor} → 新会话 ${newVendor}（日志 init 报的也是它）；交接开头“${handover.slice(0, 60).replace(/\n/g, " ")}…”；回复“${reply.trim()}”`;
  });
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: "S22（收尾）", ok: false, detail: problems.join("；") });
}
