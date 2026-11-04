// 定时任务的冒烟（S20）：真 claude。项目经理用 hub schedule add 建一个任务，把下次运行时间改到 1 分钟后（最短间隔 15 分钟，
// 没法直接建 1 分钟的），守护进程的调度器到点往项目经理的对话发“【定时任务：…】”消息，项目经理按任务说明回复。
import { openDatabase } from "../../src/daemon/store/index.ts";
import { systemEventOf } from "../../src/shared/index.ts";
import { join } from "node:path";
import { MODEL, Smoke, expect, scenario, waitUntil, type Outcome } from "./kit.ts";
import { messagesOf } from "../e2e/harness.ts";

export async function runSchedules(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (!only("S20")) return;
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, "S20 定时任务：项目经理建任务，1 分钟后到点收到消息并按时回复", async () => {
    const secret = `PEAR-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const { conversationId } = await smoke.client.createPm({ name: "阿周", mode: "hands_on", defaultModel: MODEL, persona: "阿周：简洁、直接。", folder: smoke.folder("s19") });
    await smoke.ask(
      conversationId,
      `请用 hub schedule add 建一个定时任务：名字“冒烟”，每隔 15 分钟（--every 15m），任务说明是“只回复这一句：定时暗号 ${secret}”。建完只回复“建好了”。`,
    );
    const [row] = smoke.query<{ id: number; name: string; every_minutes: number }>("SELECT * FROM schedules");
    expect(row !== undefined && row.name === "冒烟" && row.every_minutes === 15, `schedules 里没有预期的那一行：${JSON.stringify(row)}`);

    // 改到 1 分钟后到点
    const due = Date.now() + 60_000;
    const db = openDatabase(join(smoke.env.home, "state", "hub.sqlite"));
    try {
      db.run("UPDATE schedules SET next_run_at = ? WHERE id = ?", due, row.id);
    } finally {
      db.close();
    }
    const run = await waitUntil(
      "定时消息被项目经理处理完",
      async () => {
        const m = messagesOf(await smoke.client.state(), conversationId).find((x) => systemEventOf(x)?.event === "schedule.run");
        return m?.status === "replied" ? m : undefined;
      },
      150_000,
    );
    expect(run.createdAt >= due && run.createdAt < due + 90_000, `不是按时发的：到点 ${due}，发出 ${run.createdAt}`);
    expect(run.text.startsWith("【定时任务：冒烟（原定 ") && run.text.includes(secret), `消息不对：${run.text}`);
    const replies = (await smoke.repliesAfter(conversationId, run.id)).join("\n");
    expect(replies.includes(secret), `项目经理没按任务说明回复：${replies}`);
    const [after] = smoke.query<{ last_status: string; next_run_at: number }>("SELECT * FROM schedules");
    expect(after!.last_status === "sent" && after!.next_run_at > Date.now(), `last_status/next_run_at 不对：${JSON.stringify(after)}`);
    return `到点后 ${Math.round((run.createdAt - due) / 1000)} 秒发出，回复“${replies.trim()}”`;
  });
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) outcomes.push({ name: "S20（收尾）", ok: false, detail: problems.join("；") });
}
