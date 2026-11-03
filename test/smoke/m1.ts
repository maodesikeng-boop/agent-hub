// M1 的 S1～S4（m1-plan 第 4 节），共用一个守护进程、一个私聊串起来跑。
// S1 连续聊两轮；S2 重启守护进程后接着聊，记得之前说的；S3 停止：控制消息管用、进程还在；S4 忙时连发两条，下一轮两条都回应到。
// M2 起 spawn 加了 detached（claude 在自己的进程组），S2（关机、不留进程）和 S3（停止、进程不换）顺带验这个改动没伤到它们。
import { isAlive, messageById, waitForStatus, waitUntil } from "../e2e/harness.ts";
import { Smoke, TURN_MS, expect, scenario, sleep, type Outcome } from "./kit.ts";

export async function runM1(outcomes: Outcome[], smoke: Smoke): Promise<void> {
  const chat = smoke.privateId;
  const post = (text: string) => smoke.client.post(chat, text);

  const s1 = await scenario(outcomes, "S1 连续聊两轮", async () => {
    await waitForStatus(smoke.client, await post("记住暗号：蓝鲸。只回复“记住了”三个字。"), "replied", TURN_MS);
    await waitForStatus(smoke.client, await post("暗号是什么？只回复暗号本身。"), "replied", TURN_MS);
    const reply = await smoke.lastReply(chat);
    expect(reply.includes("蓝鲸"), `第二轮回复里没有“蓝鲸”：${reply}`);
    return `第二轮回复“${reply.trim()}”`;
  });

  await scenario(outcomes, "S2 重启后接着聊", async () => {
    expect(s1, "S1 没过，跳过");
    const { vendorSessionId } = smoke.sessionRow();
    const exit = await smoke.terminate();
    expect(exit.code === 0, `关机退出码 ${exit.code}`);
    expect(smoke.processesOf(vendorSessionId).length === 0, "关机后还有 claude 进程");
    await smoke.start();
    const before = (await smoke.client.state()).conversations[0]!.messages.length;
    await waitForStatus(smoke.client, await post("我刚才让你记住的暗号是什么？只回复暗号本身。"), "replied", TURN_MS);
    const reply = await smoke.lastReply(chat);
    expect(reply.includes("蓝鲸"), `重启后回复里没有“蓝鲸”：${reply}`);
    return `重启前 ${before} 条消息都在，cookie 仍有效，回复“${reply.trim()}”`;
  });

  await scenario(outcomes, "S3 停止：控制消息管用、进程还在", async () => {
    const a = await post("写一篇 4000 字的中文长文，题目是《海边的一天》，分十节。不要用任何工具。");
    await waitForStatus(smoke.client, a, "processing", TURN_MS);
    const pidBefore = smoke.sessionRow().pid;
    // 小模型写得快：开始处理后很快就停
    await sleep(500);
    const status = await smoke.client.stop(chat);
    expect(status === 202, `POST stop 返回 ${status}`);
    const stopped = await waitUntil(
      "message stopped",
      async () => {
        const m = messageById(await smoke.client.state(), a);
        return m?.status === "stopped" || m?.status === "replied" || m?.status === "failed" ? m : undefined;
      },
      30_000,
    );
    expect(stopped.status === "stopped", `消息标的是 ${stopped.status}，不是已停止（可能停止前就写完了）`);
    const pidAfter = smoke.sessionRow().pid;
    expect(pidBefore !== null && pidAfter === pidBefore && isAlive(pidBefore), `进程变了或不在了（停止前 ${pidBefore}，停止后 ${pidAfter}）：控制消息可能没管用，退回了 SIGINT`);
    await waitForStatus(smoke.client, await post("只回复一个字：在"), "replied", TURN_MS);
    expect(smoke.sessionRow().pid === pidBefore, "再发一条时换了进程");
    return `已停止，进程 ${pidBefore} 没换，再发一条照常回复`;
  });

  await scenario(outcomes, "S4 忙时连发两条，下一轮都回应到", async () => {
    const a = await post("写一篇 800 字的中文文章，题目随意。不要用任何工具。");
    await waitForStatus(smoke.client, a, "processing", TURN_MS);
    const b = await post("补充一：等你写完，下一条回复里要提到“苹果”。");
    const c = await post("补充二：下一条回复里还要提到“香蕉”。");
    for (const id of [a, b, c]) await waitForStatus(smoke.client, id, "replied", TURN_MS);
    const reply = (await smoke.repliesAfter(chat, c)).join("\n");
    const merged = smoke.writtenTexts(smoke.sessionRow().id).some((l) => l.includes("【用户连发了 2 条】") && l.includes("补充一") && l.includes("补充二"));
    expect(merged, "没在 claude 的输入里找到拼成一条的“【用户连发了 2 条】”");
    expect(reply.includes("苹果") && reply.includes("香蕉"), `下一轮回复没同时提到苹果和香蕉：${reply.slice(0, 200)}`);
    return "两条拼成一条写进去，下一轮回复同时提到了苹果和香蕉";
  });
}
