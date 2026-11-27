import { describe, expect, it } from "vitest";
import { assembleBudgetedPreamble, sliceUtf8TailSafe } from "./handover-budget.ts";
import {
  VENDOR_SWITCH_ANCHOR_HINT,
  VENDOR_SWITCH_TRUNCATED_HINT,
  collectGenerationEntriesNewestFirst,
  describeGenerationTranscripts,
  formatGenerationMessage,
  vendorSwitchPreambleHeader,
} from "./vendor-switch-context.ts";
import type { Message, SystemMessageMeta, WorkerMessageMeta } from "../../shared/domain.ts";

function hasNoLoneSurrogates(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function makeMsg(over: Partial<Message> & { id: number }): Message {
  return {
    id: over.id,
    conversationId: over.conversationId ?? 1,
    sessionId: over.sessionId ?? 1,
    workerId: over.workerId ?? null,
    sender: over.sender ?? "user",
    kind: over.kind ?? "text",
    text: over.text ?? "",
    meta: over.meta ?? null,
    collapsed: over.collapsed ?? false,
    dedupeKey: over.dedupeKey ?? `k:${over.id}`,
    status: over.status === undefined ? "replied" : over.status,
    failureReason: over.failureReason ?? null,
    createdAt: over.createdAt ?? over.id * 100,
    updatedAt: over.updatedAt ?? over.id * 100,
  };
}

describe("sliceUtf8TailSafe", () => {
  it("在 emoji UTF-16 代理对与多字节 UTF-8 边界切分时绝不产生半截码元", () => {
    const text = "甲😀乙🚀丙";
    expect(sliceUtf8TailSafe(text, Buffer.byteLength(text, "utf8"))).toBe("甲😀乙🚀丙");
    for (let limit = 0; limit <= Buffer.byteLength(text, "utf8"); limit++) {
      const sliced = sliceUtf8TailSafe(text, limit);
      expect(Buffer.byteLength(sliced, "utf8")).toBeLessThanOrEqual(limit);
      expect(hasNoLoneSurrogates(sliced)).toBe(true);
    }
    expect(sliceUtf8TailSafe("😀", 3)).toBe("");
    expect(sliceUtf8TailSafe("abc", 0)).toBe("");
  });
});

describe("formatGenerationMessage 真值表", () => {
  const TARGET_SESSION = 10;

  it("用户消息：保留已回复/失败/停止与附件完整本机路径；排除 rewound、cancelled 与正发往目标会话的在途消息", () => {
    const withAttachment = makeMsg({
      id: 1,
      sender: "user",
      text: "请看这张报错截图",
      status: "replied",
      meta: {
        attachments: [
          { id: "up1", name: "err.png", path: "/Users/test/.agent-hub/uploads/up1/err.png", size: 120, mime: "image/png" },
        ],
      },
    });
    const formatted = formatGenerationMessage(withAttachment, TARGET_SESSION);
    expect(formatted).toContain("用户：请看这张报错截图");
    expect(formatted).toContain("`/Users/test/.agent-hub/uploads/up1/err.png`");

    expect(formatGenerationMessage(makeMsg({ id: 2, sender: "user", text: "撞上额度失败的那句", status: "failed" }), TARGET_SESSION)).toBe(
      "用户：撞上额度失败的那句",
    );
    expect(formatGenerationMessage(makeMsg({ id: 3, sender: "user", text: "中途停掉的那句", status: "stopped" }), TARGET_SESSION)).toBe(
      "用户：中途停掉的那句",
    );

    // 二次 Esc 已撤回、已取消、排队的、正发往新会话自身的全部排除
    expect(
      formatGenerationMessage(makeMsg({ id: 4, sender: "user", text: "已撤回", status: "stopped", meta: { rewound: true } }), TARGET_SESSION),
    ).toBeNull();
    expect(formatGenerationMessage(makeMsg({ id: 5, sender: "user", text: "已取消", status: "cancelled" }), TARGET_SESSION)).toBeNull();
    expect(formatGenerationMessage(makeMsg({ id: 6, sender: "user", text: "排队中", status: "queued", sessionId: TARGET_SESSION }), TARGET_SESSION)).toBeNull();
    expect(
      formatGenerationMessage(makeMsg({ id: 7, sender: "user", text: "已送达新会话", status: "delivered", sessionId: TARGET_SESSION }), TARGET_SESSION),
    ).toBeNull();
    expect(
      formatGenerationMessage(makeMsg({ id: 8, sender: "user", text: "新会话处理中", status: "processing", sessionId: TARGET_SESSION }), TARGET_SESSION),
    ).toBeNull();
  });

  it("PM 消息：保留正文并还原 AskMeta 选项与拍板状态；排除工具调用行与 in_session 写交接草稿", () => {
    expect(formatGenerationMessage(makeMsg({ id: 10, sender: "agent", text: "好的，马上安排", status: null }), TARGET_SESSION)).toBe(
      "你：好的，马上安排",
    );

    const askPending = makeMsg({
      id: 11,
      sender: "agent",
      text: "切厂商方案怎么定？",
      status: null,
      meta: { needsUser: true, options: ["直接照做", "再调一下"], recommended: "直接照做" },
    });
    expect(formatGenerationMessage(askPending, TARGET_SESSION)).toBe(
      "你：切厂商方案怎么定？\n[选项：1. 直接照做（推荐） / 2. 再调一下；状态：待用户确认]",
    );

    const askChosen = makeMsg({
      id: 12,
      sender: "agent",
      text: "切厂商方案怎么定？",
      status: null,
      meta: { needsUser: true, answered: true, options: ["直接照做", "再调一下"], chosenOption: "再调一下" },
    });
    expect(formatGenerationMessage(askChosen, TARGET_SESSION)).toBe(
      "你：切厂商方案怎么定？\n[选项：1. 直接照做 / 2. 再调一下；状态：已选「再调一下」]",
    );

    expect(
      formatGenerationMessage(makeMsg({ id: 13, sender: "agent", kind: "tool", text: "Bash: hub status", status: null }), TARGET_SESSION),
    ).toBeNull();
    expect(
      formatGenerationMessage(makeMsg({ id: 14, sender: "agent", text: "写交接草稿", status: null, meta: { handover: true } }), TARGET_SESSION),
    ).toBeNull();
  });

  it("Worker 消息：完整保留汇报原文（含唤醒汇报与 status=null 静默检查点汇报）、报错与直聊抄送；排除 started/ended 与 queued 在途项", () => {
    const fullReport = "【Worker #540（审查实现）的汇报】\n\n已完成审查。\n\n=== 汇报 ===\n状态: 做完了\n摘要: 全绿通过\nPR: https://example.com/pr/1\n=== 汇报结束 ===";
    const reportMeta: WorkerMessageMeta = {
      workerId: 540,
      workerConversationId: 88,
      title: "审查实现",
      readonly: true,
      event: "report",
      status: "done",
      summary: "全绿通过",
    };
    expect(
      formatGenerationMessage(makeMsg({ id: 20, sender: "system", kind: "worker", text: fullReport, status: "replied", meta: reportMeta }), TARGET_SESSION),
    ).toBe(fullReport);
    // 任务图静默存档 / confirm 检查点的汇报（status 为 null）同样一字不差保留
    expect(
      formatGenerationMessage(makeMsg({ id: 21, sender: "system", kind: "worker", text: fullReport, status: null, meta: reportMeta }), TARGET_SESSION),
    ).toBe(fullReport);
    // 排队待发给新会话的汇报不写进继承包，防止和紧接其后的投递重复
    expect(
      formatGenerationMessage(
        makeMsg({ id: 22, sender: "system", kind: "worker", text: fullReport, status: "queued", sessionId: TARGET_SESSION, meta: reportMeta }),
        TARGET_SESSION,
      ),
    ).toBeNull();

    const startedMeta: WorkerMessageMeta = { ...reportMeta, event: "started", status: null, summary: null };
    const endedMeta: WorkerMessageMeta = { ...reportMeta, event: "ended", status: null, summary: null };
    expect(formatGenerationMessage(makeMsg({ id: 23, sender: "system", kind: "worker", text: "已派出", status: null, meta: startedMeta }), TARGET_SESSION)).toBeNull();
    expect(formatGenerationMessage(makeMsg({ id: 24, sender: "system", kind: "worker", text: "已收工", status: null, meta: endedMeta }), TARGET_SESSION)).toBeNull();
  });

  it("系统事件：纳入交付单、定时触发、Worker 超时等业务通知；严格排除 persona.changed / session.renewed 等会话切换噪音", () => {
    const deliveryMeta: SystemMessageMeta = { event: "task_graph.ready_to_finish", graphId: 6, seq: 1 };
    const deliveryText = "【任务图 #6「编排简化」全部步骤做完，等你交付】\n1. [完了] s1";
    expect(
      formatGenerationMessage(makeMsg({ id: 30, sender: "system", kind: "text", text: deliveryText, status: "replied", meta: deliveryMeta }), TARGET_SESSION),
    ).toBe(deliveryText);

    const timeoutMeta: SystemMessageMeta = { event: "worker.max_time_exceeded", workerId: 9, workerConversationId: 99, maxTimeMs: 60_000 };
    expect(
      formatGenerationMessage(
        makeMsg({ id: 31, sender: "system", kind: "text", text: "【系统】Worker #9 本轮已跑满 1m", status: "replied", meta: timeoutMeta }),
        TARGET_SESSION,
      ),
    ).toBe("【系统通知】Worker #9 本轮已跑满 1m");

    const personaChanged: SystemMessageMeta = { event: "persona.changed", pmId: 1, personaChangeId: 2, revertOf: null };
    const renewed: SystemMessageMeta = { event: "session.renewed", sessionId: 5, fromSessionId: 4 };
    expect(
      formatGenerationMessage(makeMsg({ id: 32, sender: "system", kind: "text", text: "你改了小林的设置", status: null, meta: personaChanged }), TARGET_SESSION),
    ).toBeNull();
    expect(
      formatGenerationMessage(makeMsg({ id: 33, sender: "system", kind: "text", text: "旧交接", status: null, meta: renewed }), TARGET_SESSION),
    ).toBeNull();
  });

  it("excludes hidden checklist reminders from the vendor switch log", () => {
    const meta: SystemMessageMeta = { event: "checklist.reminder", sessionId: 1, uuid: "turn-1", toolUseId: "edit-1" };
    const reminder = makeMsg({
      id: 34,
      sender: "system",
      sessionId: meta.sessionId,
      text: "Update the progress checklist.",
      collapsed: true,
      status: "replied",
      meta,
    });
    expect(formatGenerationMessage(reminder, TARGET_SESSION)).toBeNull();
  });
});

describe("collectGenerationEntriesNewestFirst 与 assembleBudgetedPreamble", () => {
  it("keeps a delivered PM wakeup in the vendor switch log and leaves queued wakeups for delivery", () => {
    const meta: SystemMessageMeta = { event: "pm.wakeup", source: "task_graph", ref: "checkpoint-result" };
    const text = "【任务图 #6】用户已打回方案，等你处理";
    const collected = collectGenerationEntriesNewestFirst([
      makeMsg({ id: 2, sender: "system", status: "queued", text: "另一条尚未发送的通知", meta: { ...meta, ref: "queued" } }),
      makeMsg({ id: 1, sender: "system", status: "replied", text, meta }),
    ], { targetSessionId: 10, maxBytes: 10_000 });
    const preamble = assembleBudgetedPreamble(
      {
        header: vendorSwitchPreambleHeader({ fromVendor: "claude", toVendor: "codex", hasSkills: false, transcriptSummary: "" }),
        skillsIndex: null,
        summaryHeading: "## 本代起点摘要（上次会话换代时保存的背景）",
        summaryBody: null,
        historyHeading: "## 本代完整对话与 Worker 汇报记录",
        historyEntriesNewestFirst: collected.entries,
        historyEmptyText: "（本代尚无历史消息）",
        historyTruncatedHint: VENDOR_SWITCH_TRUNCATED_HINT,
        pendingAsksSection: null,
        agendaSection: null,
      },
      { vendor: "codex" },
    ).text!;
    expect(preamble).toContain(text);
    expect(preamble).not.toContain("另一条尚未发送的通知");
  });

  it("超出字节上限时只保留最新尾部并保证 UTF-16 合法，未超限时完整无损且不标省略提示", () => {
    const newestFirst = [
      makeMsg({ id: 3, sender: "agent", text: "最新回复🎯完成", status: null }),
      makeMsg({ id: 2, sender: "user", text: `中间长消息${"🔥".repeat(30)}结尾`, status: "replied" }),
      makeMsg({ id: 1, sender: "user", text: "最早的一句旧话", status: "replied" }),
    ];
    const full = collectGenerationEntriesNewestFirst(newestFirst, { targetSessionId: 99, maxBytes: 10_000 });
    expect(full.truncated).toBe(false);
    expect([...full.entries].reverse().join("\n\n")).toBe(
      `用户：最早的一句旧话\n\n用户：中间长消息${"🔥".repeat(30)}结尾\n\n你：最新回复🎯完成`,
    );

    const capped = collectGenerationEntriesNewestFirst(newestFirst, { targetSessionId: 99, maxBytes: 160 });
    expect(capped.truncated).toBe(true);
    const assembled = assembleBudgetedPreamble(
      {
        header: vendorSwitchPreambleHeader({
          fromVendor: "claude",
          toVendor: "codex",
          hasSkills: false,
          transcriptSummary: "本代前序会话的原始记录：Claude Code（claude）：/tmp/s1.jsonl",
        }),
        skillsIndex: null,
        summaryHeading: "## 本代起点摘要（上次会话换代时保存的背景）",
        summaryBody: `${VENDOR_SWITCH_ANCHOR_HINT}\n\n早间自动换代摘要`,
        historyHeading: "## 本代完整对话与 Worker 汇报记录",
        historyEntriesNewestFirst: capped.entries,
        historyEmptyText: "（本代尚无历史消息）",
        historyTruncatedHint: VENDOR_SWITCH_TRUNCATED_HINT,
        pendingAsksSection: null,
        agendaSection: null,
      },
      { vendor: "codex", historyMaxBytes: 160 },
    );
    const preamble = assembled.text!;
    expect(assembled.historyTruncated).toBe(true);
    expect(hasNoLoneSurrogates(preamble)).toBe(true);
    expect(preamble).toContain("你：最新回复🎯完成");
    expect(preamble).not.toContain("最早的一句旧话");
    expect(preamble).toContain("从 Claude Code（claude）切换到了 Codex（codex）");
    expect(preamble).toContain(`## 本代起点摘要（上次会话换代时保存的背景）\n\n${VENDOR_SWITCH_ANCHOR_HINT}\n\n早间自动换代摘要`);
    expect(preamble).toContain(VENDOR_SWITCH_TRUNCATED_HINT);
    expect(preamble).not.toContain("## 交接");
    expect(preamble).not.toContain("上一个会话没有写交接");
  });

  it("多跳原始记录提取：保留可读厂商 .jsonl，对不可跨厂直读厂商（agy / deepseek / cursor）隐藏二进制路径并给说明", () => {
    const summary = describeGenerationTranscripts(
      [
        { id: 3, vendor: "agy", vendorSessionId: "u-agy", cwd: "/w" },
        { id: 2, vendor: "codex", vendorSessionId: "u-codex", cwd: "/w" },
        { id: 1, vendor: "claude", vendorSessionId: "u-claude", cwd: "/w" },
      ],
      ({ vendor, vendorSessionId }) => `/logs/${vendor}-${vendorSessionId}.bin`,
    );
    expect(summary).toContain("Claude Code（claude）：/logs/claude-u-claude.bin");
    expect(summary).toContain("Codex（codex）：/logs/codex-u-codex.bin");
    expect(summary).toContain("Antigravity（agy）");
    expect(summary).not.toContain("u-agy.bin");
  });
});
