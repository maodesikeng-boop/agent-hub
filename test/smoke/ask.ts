// hub ask 的冒烟（S20）：项目经理遇到要用户选的事，用 hub ask 问；消息带 needsUser 标记、没被标成已处理。
// 网页顶部的“等你确定”条是网页自己按这个标记算的（src/web/ask.test.tsx 测了），这里只看真 claude 肯不肯用 hub ask。
import { HUB_COMMAND, askOf } from "../../src/shared/index.ts";
import { messagesOf, waitUntil } from "../e2e/harness.ts";
import { MODEL, Smoke, TURN_MS, expect, scenario, type Outcome } from "./kit.ts";

export async function runAsk(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S20")) return;
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, "S20 项目经理要用户选方案：用 hub ask 问，消息带“等你确定”标记", async () => {
    const { conversationId } = await smoke.client.createPm({
      name: "阿周",
      mode: "manage_only",
      defaultModel: MODEL,
      persona: "阿周：简洁、直接。",
      folder: smoke.folder("s19"),
    });
    const sent = await smoke.client.post(
      conversationId,
      `我想给登录页换个配色，有方案 A（蓝色）和方案 B（绿色）。这得我来拍板：请你用 \`${HUB_COMMAND} ask --stdin\` 把这两个方案发给我让我选，发完就停，别的什么都不要做。`,
    );
    const asked = await waitUntil(
      "a hub ask message",
      async () => messagesOf(await smoke.client.state(), conversationId).find((m) => m.id > sent && askOf(m) !== null),
      TURN_MS,
    );
    expect(askOf(asked)?.answered !== true, "刚发出的提问不该是已处理");
    expect(/蓝|绿|A|B/.test(asked.text), `提问里没有方案：${asked.text}`);
    const calls = smoke.query<{ command: string; ok: number }>("SELECT command, ok FROM hub_calls WHERE command = 'ask'");
    expect(calls.length === 1 && calls[0]!.ok === 1, `hub_calls 里没有成功的 ask：${JSON.stringify(calls)}`);
    return `消息 ${asked.id}：“${asked.text.replace(/\s+/g, " ").slice(0, 60)}…”`;
  });
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: "S20（收尾）", ok: false, detail: problems.join("；") });
}
