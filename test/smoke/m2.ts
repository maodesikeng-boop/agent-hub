// M2 的 S5～S9（m2-plan 第 4 节“必须用真 claude 测的”）。每个场景自己起一个守护进程和临时数据目录，互不牵连；
// 能用界面接口（不花额度）建的东西（项目经理、项目、文件夹）就用界面接口建，只有场景要验的那一步让真 claude 去做。
// S5 私聊里一句话建项目；S6 挂文件夹后下一条消息前自动重启；S7 换项目经理（交接走 heredoc）；S8 说“以后用列表”；S9 一个项目经理两个群同时问。
import { readFileSync } from "node:fs";
import { RELAUNCH_NOTE } from "../../src/shared/index.ts";
import { waitForStatus, waitUntil } from "../e2e/harness.ts";
import { MODEL, Smoke, TURN_MS, expect, looksLikeList, scenario, type Outcome } from "./kit.ts";

type HubCallRow = { session_id: number; command: string; ok: number; error_code: string | null; result: string };
const hubCalls = (smoke: Smoke) => smoke.query<HubCallRow>("SELECT session_id, command, ok, error_code, result FROM hub_calls ORDER BY id");

/** 每个 M2 场景的外壳：起、跑、收尾；收尾发现问题或场景失败，就把数据目录留着。 */
async function inFreshSmoke(outcomes: Outcome[], name: string, fn: (smoke: Smoke) => Promise<string>): Promise<void> {
  const smoke = await Smoke.boot();
  const ok = await scenario(outcomes, name, () => fn(smoke));
  const problems = await smoke.finish(!ok);
  if (problems.length > 0) {
    outcomes.push({ name: `${name}（收尾）`, ok: false, detail: problems.join("；") });
    console.log(`  收尾发现问题：${problems.join("；")}`);
  }
}

/** agent 敲过的、以 hub 开头的命令。 */
const hubCommands = (smoke: Smoke, sessionId: number) => smoke.bashCommands(sessionId).filter((c) => /(^|\n|;|&&)\s*hub\b/.test(c));

export async function runM2(outcomes: Outcome[], only: (name: string) => boolean): Promise<void> {
  if (only("S5")) {
    await inFreshSmoke(outcomes, "S5 私聊里一句话建项目", async (smoke) => {
      const dir = smoke.folder("foo");
      const { replies } = await smoke.ask(smoke.privateId, `在 ${dir} 建一个叫 smoke-foo 的项目。建好后只回复“建好了”。`);
      const state = await smoke.client.state();
      const project = state.projects.find((p) => p.name === "smoke-foo");
      const session = smoke.sessionRow();
      const create = hubCommands(smoke, session.id).filter((c) => c.includes("hub project create"));
      expect(project, `没建出项目；agent 敲的命令：${JSON.stringify(smoke.bashCommands(session.id))}；回复：${replies.join("|")}`);
      expect(create.length > 0, "agent 没敲 hub project create");
      expect(create.every((c) => !c.includes("$")), `hub project create 命令里有变量：${create.join(" | ")}`);
      const denials = smoke.permissionDenials(session.id);
      expect(denials.length === 0, `有调用被权限拦了：${denials.join(" | ")}`);
      expect(state.folders.some((f) => f.projectId === project.id && f.isMain && f.path === dir), `主文件夹不对：${JSON.stringify(state.folders)}`);
      const calls = hubCalls(smoke).filter((c) => c.command === "project.create");
      expect(calls.length === 1 && calls[0]!.ok === 1 && calls[0]!.session_id === session.id, `hub_calls 不对：${JSON.stringify(hubCalls(smoke))}`);
      const group = state.conversations.find((c) => c.conversation.projectId === project.id);
      expect(group?.messages.some((m) => m.sender === "system" && m.text.startsWith("项目已建好")), "群里没有“项目已建好”");
      return `项目 ${project.id} 建好，命令“${create[0]}”没被拦、没有变量`;
    });
  }

  if (only("S6")) {
    await inFreshSmoke(outcomes, "S6 挂文件夹后下一条消息前自动重启", async (smoke) => {
      const main = smoke.folder("main", { "readme.txt": "main folder" });
      const secret = `KIWI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const extra = smoke.folder("extra", { "secret.txt": `暗号是 ${secret}\n` });
      const { conversationId } = await smoke.client.createProject({ name: "smoke-attach", folder: main, pmId: smoke.pmId });
      await smoke.ask(conversationId, `用 hub project attach 把文件夹 ${extra} 挂到这个项目上。挂好后只回复“挂好了”。`);
      const attached = (await smoke.client.state()).folders.some((f) => f.path === extra && !f.isMain);
      expect(attached, "项目里没有新挂的文件夹");
      const session = await smoke.currentSession(conversationId);
      const pidBefore = smoke.sessionRow(session.sessionId).pid;
      const { replies } = await smoke.ask(conversationId, `读一下 ${extra}/secret.txt，只回复里面的暗号原文。`);
      const row = smoke.sessionRow(session.sessionId);
      expect(row.pid !== null && row.pid !== pidBefore, `进程没换（${pidBefore} → ${row.pid}）：没有在下一条消息前重启`);
      const cmdline = smoke.claudeCommandLine(row.vendorSessionId);
      expect(cmdline.includes("--resume") && cmdline.includes(`--add-dir ${extra}`), `重启后的命令行不对：${cmdline}`);
      expect(smoke.writtenTexts(session.sessionId).some((t) => t.includes(RELAUNCH_NOTE)), "重启后写进去的第一条前面没有 RELAUNCH_NOTE");
      expect(replies.join("\n").includes(secret), `回复里没有暗号 ${secret}：${replies.join("|")}`);
      const denials = smoke.permissionDenials(session.sessionId);
      expect(denials.length === 0, `有调用被权限拦了：${denials.join(" | ")}`);
      return `进程 ${pidBefore} → ${row.pid}（--resume --add-dir），读到了新文件夹里的暗号`;
    });
  }

  if (only("S7")) {
    await inFreshSmoke(outcomes, "S7 换项目经理：交接走 heredoc", async (smoke) => {
      const dir = smoke.folder("handoff", { "readme.txt": "hello" });
      const zhou = await smoke.client.createPm({ name: "阿周", mode: "hands_on", defaultModel: MODEL, persona: "阿周：简洁、直接。" });
      const { conversationId } = await smoke.client.createProject({ name: "smoke-handoff", folder: dir, pmId: smoke.pmId });
      const oldSession = await smoke.currentSession(conversationId);
      const first = await smoke.client.post(conversationId, "记住：发布日期定在周五。然后把这个项目交给阿周：先写交接（必须写上发布日期），用 `hub project assign smoke-handoff --to 阿周 --stdin` 加 heredoc（<<'EOF'）把交接正文传进去。传完回复“交接好了”。");
      await waitForStatus(smoke.client, first, "replied", TURN_MS);
      const state = await smoke.client.state();
      const assign = hubCommands(smoke, oldSession.sessionId).filter((c) => c.includes("project assign"));
      expect(assign.length > 0, `agent 没敲 hub project assign；命令：${JSON.stringify(smoke.bashCommands(oldSession.sessionId))}`);
      expect(assign.some((c) => c.includes("--stdin") && c.includes("<<")), `没用 --stdin + heredoc：${assign.join(" | ")}`);
      // 被拦不一定是 heredoc 的错：agent 常在命令后面自己加 echo "exit=$?"（带变量，会被拦）。以账本为准：heredoc 那条最终要成功。
      const denials = smoke.permissionDenials(oldSession.sessionId);
      const call = hubCalls(smoke).find((c) => c.command === "project.assign");
      expect(call?.ok === 1, `hub_calls 里 project.assign 不成功（heredoc 被拦？）：${JSON.stringify(call)}；被拦的调用：${denials.join(" | ")}`);
      expect(state.projects.find((p) => p.name === "smoke-handoff")?.pmId === zhou.pmId, "项目经理没换成阿周");
      const handoff = smoke.query<{ file: string }>("SELECT file FROM handoffs")[0];
      expect(handoff && readFileSync(handoff.file, "utf8").includes("周五"), "交接文件里没有“周五”");
      const sessions = state.sessions.filter((s) => s.conversationId === conversationId).sort((a, b) => a.generation - b.generation);
      expect(sessions.length === 2 && sessions[1]!.pmId === zhou.pmId, `群里没有阿周的新一代会话：${JSON.stringify(sessions)}`);
      const { replies } = await smoke.ask(conversationId, "发布日期是星期几？只回答星期几。");
      expect(/周五|星期五|11-06|11月6/.test(replies.join("\n")), `新项目经理没答出“周五”：${replies.join("|")}`);
      const blocked = denials.length > 0 ? `（其中 ${denials.length} 次被拦：${denials.map((d) => d.replace(/\s+/g, " ").slice(-90)).join(" | ")}）` : "";
      return `heredoc 交接成功${blocked}；阿周接手后答“${replies.join("").trim()}”`;
    });
  }

  if (only("S8")) {
    await inFreshSmoke(outcomes, "S8 说“以后回复都用列表”", async (smoke) => {
      const chat = smoke.privateId;
      await smoke.ask(
        chat,
        "以后你所有回复都用 Markdown 列表（每条以“- ”开头）。请用 hub persona edit 记下来：先 hub persona show 看原文，在原文基础上加这条要求，用 --stdin 和 heredoc 提交，理由写“用户要求用列表”。记好后回复“记好了”。",
      );
      const session = smoke.sessionRow();
      const edits = smoke.query<{ actor: string; text_after: string; text_before: string }>("SELECT actor, text_before, text_after FROM persona_changes");
      expect(edits.length === 1 && edits[0]!.actor === "pm", `persona_changes 不对：${JSON.stringify(edits.map((e) => e.actor))}`);
      expect(edits[0]!.text_after !== edits[0]!.text_before && edits[0]!.text_after.includes("列表"), "新性格设定里没有“列表”");
      expect(hubCalls(smoke).some((c) => c.command === "persona.edit" && c.ok === 1), `hub_calls 里没有成功的 persona.edit：${JSON.stringify(hubCalls(smoke))}`);
      const denials = smoke.permissionDenials(session.id);
      expect(denials.length === 0, `有调用被权限拦了：${denials.join(" | ")}`);
      const pidBefore = smoke.sessionRow().pid;
      const { replies } = await smoke.ask(chat, "用三句话介绍一下太阳系。");
      const reply = replies.join("\n");
      expect(smoke.sessionRow().pid !== pidBefore, "进程没换：改了性格设定没有在下一条前重启");
      expect(smoke.writtenTexts(session.id).some((t) => t.includes(RELAUNCH_NOTE)), "重启后写进去的第一条前面没有 RELAUNCH_NOTE");
      expect(looksLikeList(reply), `回复不是列表：${reply}`);
      return "persona.edit 成功（actor: pm），重启后下一条回复是列表";
    });
  }

  if (only("S9")) {
    await inFreshSmoke(outcomes, "S9 一个项目经理两个群同时问长问题", async (smoke) => {
      const apple = smoke.folder("apple", { "apple-notes.txt": "苹果园的笔记" });
      const banana = smoke.folder("banana", { "banana-notes.txt": "香蕉岛的笔记" });
      const a = await smoke.client.createProject({ name: "苹果园", folder: apple, pmId: smoke.pmId });
      const b = await smoke.client.createProject({ name: "香蕉岛", folder: banana, pmId: smoke.pmId });
      const ask = (name: string) => `先用工具列出这个文件夹里的文件，再写一篇 1000 字的短文，讲“${name}”这个名字的来历，开头先写出你看到的文件名。`;
      const ids = await Promise.all([smoke.client.post(a.conversationId, ask("苹果园")), smoke.client.post(b.conversationId, ask("香蕉岛"))]);
      // 两个进程要同时在跑：同一时刻两个会话都是 running，进程号不同、都活着
      const both = await waitUntil(
        "两个会话同时在跑",
        async () => {
          const [sa, sb] = await Promise.all([smoke.currentSession(a.conversationId), smoke.currentSession(b.conversationId)]);
          if (sa.status !== "running" || sb.status !== "running") return undefined;
          const [pa, pb] = [smoke.sessionRow(sa.sessionId).pid, smoke.sessionRow(sb.sessionId).pid];
          return pa !== null && pb !== null && pa !== pb ? { pa, pb } : undefined;
        },
        TURN_MS,
      );
      for (const id of ids) await waitForStatus(smoke.client, id, "replied", TURN_MS);
      const [ra, rb] = (await Promise.all([smoke.repliesAfter(a.conversationId, ids[0]), smoke.repliesAfter(b.conversationId, ids[1])])).map((r) => r.join("\n"));
      expect(ra!.includes("苹果") && !ra!.includes("香蕉"), `苹果园群的回复串了：${ra!.slice(0, 200)}`);
      expect(rb!.includes("香蕉") && !rb!.includes("苹果"), `香蕉岛群的回复串了：${rb!.slice(0, 200)}`);
      return `进程 ${both.pa}、${both.pb} 同时在跑，两个群各说各的`;
    });
  }
}
