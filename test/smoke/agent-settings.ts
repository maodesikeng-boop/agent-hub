// 资料页改模型、思考程度的冒烟（S18）：项目经理先用默认的小模型聊一句记个暗号，资料页改成 haiku + low，
// 再问暗号：下一条消息前 --resume 同一个会话重启，命令行带 --model haiku --effort low，会话日志里 init 报的是 haiku，暗号还记得。
import { API_PATHS, type EditPersonaResponse } from "../../src/shared/index.ts";
import { MODEL, Smoke, expect, scenario, type Outcome } from "./kit.ts";

export async function runAgentSettings(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S18")) return;
  const smoke = await Smoke.boot({ persist: true }); // 改设置后 --resume
  const ok = await scenario(outcomes, "S18 资料页把项目经理改成 haiku + low：下一条消息按新参数 --resume 重启，聊过的还在", async () => {
    const secret = `PEAR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { pmId, conversationId } = await smoke.client.createPm({
      name: "阿周",
      mode: "hands_on",
      defaultModel: MODEL,
      persona: "阿周：简洁、直接。",
      folder: smoke.folder("s17"),
    });
    await smoke.ask(conversationId, `记住暗号 ${secret}。这一条只回复“好”。`);
    const session = await smoke.currentSession(conversationId);
    const { vendorSessionId } = smoke.sessionRow(session.sessionId);

    const res = await fetch(smoke.client.base + API_PATHS.persona(pmId), {
      method: "PUT",
      headers: smoke.client.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ model: "haiku", effort: "low" }),
    });
    expect(res.status === 200, `PUT persona 回 ${res.status}`);
    const { persona } = (await res.json()) as EditPersonaResponse;
    expect(persona.model === "haiku" && persona.effort === "low", `资料页的值不对：${JSON.stringify(persona)}`);

    const { replies } = await smoke.ask(conversationId, "刚才的暗号是什么？只回复暗号本身。");
    // 一轮结束后进程空闲着还在，命令行就是这次的启动参数
    const cmd = smoke.claudeCommandLine(vendorSessionId);
    expect(cmd.includes(`--resume ${vendorSessionId}`), `没有用 --resume 同一个会话：${cmd}`);
    expect(cmd.includes("--model haiku --effort low"), `启动参数里没有 --model haiku --effort low：${cmd}`);
    const inits = smoke.sessionLog(session.sessionId).filter((e) => e.type === "system" && e.subtype === "init");
    const lastModel = String(inits.at(-1)?.model ?? "");
    expect(inits.length >= 2 && /haiku/i.test(lastModel), `会话日志里重启后的 init 不是 haiku：${lastModel}（init ${inits.length} 次）`);
    const reply = replies.join("\n");
    expect(reply.includes(secret), `暗号没记住，回复：${reply}`);
    return `命令行 …${cmd.slice(cmd.indexOf("--resume"), cmd.indexOf("--append-system-prompt-file")).trim()}…；init 报 ${lastModel}；回复“${reply.trim()}”`;
  });
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: "S18（收尾）", ok: false, detail: problems.join("；") });
}
