import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCatalogSystemPrompt } from "../daemon/project-catalog/prompt.ts";
import {
  AGENTS_NOTE,
  buildFingerprintPrompt,
  buildLaunchPrompt,
  buildWorkerFirstMessage,
  buildWorkerSystemPrompt,
  personaUpdateNote,
} from "../daemon/prompt.ts";
import { buildRouterSystemPrompt } from "../daemon/router/prompt.ts";
import { taskGraphManualNote } from "../daemon/task-graph-skill.ts";
import { card, noProjectContext, projectContext, workerContext } from "../daemon/test-helpers.ts";
import { handoverRequestText } from "../daemon/ledger/handover-text.ts";
import { createPmFrictionFixture, reportBlock } from "../daemon/ledger/pm-friction-fixture.ts";
import { HUB_USAGE } from "../hub/usage.ts";
import { PM_MODES, systemEventOf } from "./domain.ts";
import {
  HUB_COMMANDS,
  STDIN_SHELL_NOTE,
  TASK_GRAPH_CREATE_JSON_HINT,
  TASK_GRAPH_PATCH_JSON_HINT,
} from "./hub.ts";
import { launchFingerprint } from "./launch.ts";
import {
  WORKFLOW_OVERFIT_RULE_IDS,
  auditShippedPromptSurfaces,
  describeWorkflowOverfitViolation,
  workflowOverfitViolationsIn,
  type ShippedPromptSurface,
  type WorkflowOverfitRuleId,
} from "./prompt-policy.ts";
import { REVIEW_CHECKLIST, parseReviewVerdict, type StoredReviewVerdict } from "./review.ts";
import {
  TASK_GRAPH_SKILL_DESCRIPTION,
  taskGraphSkillBody,
  taskGraphSkillCatalogEntry,
  taskGraphSkillMarkdown,
} from "./task-graph-skill.ts";
import { AGENT_VENDORS } from "./vendors.ts";
import { WORKER_REPORT_FORMAT, parseWorkerReport } from "./worker.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prompt-deoverfit-"));
  tempDirs.push(dir);
  return dir;
}

function collectShippedSurfaces(cwd: string): ShippedPromptSurface[] {
  const project = card(1, "demo-app", "/work/demo-app");
  const surfaces: ShippedPromptSurface[] = [
    { name: "router system prompt", text: buildRouterSystemPrompt() },
    { name: "project catalog prompt", text: buildCatalogSystemPrompt() },
    { name: "task graph skill", text: taskGraphSkillMarkdown() },
    { name: "task graph manual note", text: taskGraphManualNote(undefined, 1) },
    { name: "task graph create json hint", text: TASK_GRAPH_CREATE_JSON_HINT },
    { name: "task graph patch json hint", text: TASK_GRAPH_PATCH_JSON_HINT },
    { name: "review checklist", text: REVIEW_CHECKLIST },
    { name: "hub usage", text: HUB_USAGE },
    { name: "worker report format", text: WORKER_REPORT_FORMAT },
    { name: "handover request (auto)", text: handoverRequestText({ auto: true, transcriptPath: null, forked: false }) },
    { name: "handover request (manual forked)", text: handoverRequestText({ auto: false, transcriptPath: "/logs/t.jsonl", forked: true }) },
  ];
  for (const vendor of AGENT_VENDORS) {
    for (const mode of PM_MODES) {
      const pm = { ...projectContext().pm, vendor, mode };
      surfaces.push({ name: `PM prompt (${vendor}, ${mode})`, text: buildLaunchPrompt(projectContext({ pm, project }), cwd) });
      surfaces.push({ name: `PM prompt without project (${vendor}, ${mode})`, text: buildLaunchPrompt(noProjectContext({ pm }), cwd) });
    }
    surfaces.push({
      name: `Worker prompt (${vendor})`,
      text: buildWorkerSystemPrompt({ ...workerContext(), vendor, project }, cwd),
    });
  }
  return surfaces;
}

describe("new behavior: shipped prompt de-overfitting (expected to fail before implementation)", () => {
  it("S1: PM system prompt across all 8 vendors and both modes removes baked-in plan/review/acceptance workflows and states opt-in boundaries", () => {
    const cwd = makeTempDir();
    const project = card(1, "demo-app", "/work/demo-app");
    const forbidden = [
      "拆成「写方案 → 写代码 → 审查」",
      "不要把同一个单元内的工作拆成两路去并行",
      "不要自己写详细方案",
      "让 Worker 自己去做方案",
      "说服你的领导",
      "不读代码 diff，代码质量由审查负责",
      "改动风险较高而还没审查的",
      "以“请验收”开头",
      "也不贴到 PR 评论里代替",
      "要求“主控亲自审子代理 diff”的，换成在图里加审查步骤",
      "建图、改图、换人、审查的做法",
    ];
    for (const vendor of AGENT_VENDORS) {
      for (const mode of PM_MODES) {
        const pm = { ...projectContext().pm, vendor, mode, persona: "" };
        const prompt = buildLaunchPrompt(projectContext({ pm, project }), cwd);
        for (const phrase of forbidden) {
          expect(prompt, `${vendor}/${mode} should not contain "${phrase}"`).not.toContain(phrase);
        }
        expect(prompt, `${vendor}/${mode} must state that review and extra process gates are opt-in`).toMatch(
          /只在用户要求或项目自身规矩|仅在用户要求或项目规矩|按用户要求或项目自身规矩/u,
        );
      }
    }
  });

  it("S2: Task Graph skill, JSON hints, and hub help stay workflow-neutral without defaulting to cross-vendor review", () => {
    expect(TASK_GRAPH_CREATE_JSON_HINT).not.toContain('"review":true');
    expect(TASK_GRAPH_CREATE_JSON_HINT).not.toMatch(/"vendor"\s*:/u);
    expect(TASK_GRAPH_PATCH_JSON_HINT).not.toContain('"review"');
    expect(TASK_GRAPH_SKILL_DESCRIPTION).not.toContain("加独立审查步骤");
    expect(taskGraphManualNote(undefined, 1)).not.toContain("建图、改图、换人、审查的做法");

    const body = taskGraphSkillBody();
    for (const phrase of [
      "不要把一个需求切成前端、后端各一个 Worker",
      "只在三种时候另起一步",
      "缺审查或证据",
    ]) {
      expect(body, `taskGraphSkillBody should not contain "${phrase}"`).not.toContain(phrase);
    }
    expect(body).toContain('"review": true');
    expect(HUB_USAGE).not.toContain("不要派普通 Worker 审");
    expect(HUB_USAGE).not.toContain("建图、改图、换人、审查的做法");
  });

  it("S3a: runtime Task Graph create and patch receipts omit same-vendor review warnings", () => {
    const fx = createPmFrictionFixture();
    try {
      const created = fx.createGraph({
        title: "neutral workflow test",
        goal: "Ship a small change and check receipts.",
        steps: [
          { key: "impl", title: "implement", brief: "Implement the requested change." },
          { key: "review", title: "optional review", brief: "Check the change.", review: true },
        ],
      });
      expect(created.text).not.toContain("同一家模型");
      expect(created.text).not.toContain("提醒：审查步骤");

      const patched = fx.patchGraph(
        {
          addSteps: [{ key: "verify", title: "second check", brief: "Double-check.", review: true, base: "feature/x", deps: [] }],
        },
        created.data.graph.id,
      );
      expect(patched.text).not.toContain("同一家模型");
      expect(patched.text).not.toContain("提醒：审查步骤");
    } finally {
      fx.close();
    }
  });

  it("S3b: completed Task Graph delivery wakeups omit unrequested review nudges", async () => {
    const fx = createPmFrictionFixture();
    try {
      const simple = fx.createGraph({
        title: "single step delivery",
        goal: "Finish one step cleanly.",
        steps: [{ key: "work", title: "do work", brief: "Finish the requested work." }],
      });
      const workNode = simple.data.graph.nodes[0]!;
      await fx.startWorktree(workNode.activeWorkerId!);
      fx.workerTurn(workNode.activeWorkerId!, reportBlock({ status: "做完了", summary: "Completed the requested task." }));

      const deliveryMsg = fx
        .pmSystemMessages()
        .find((m) => systemEventOf(m)?.event === "pm.wakeup" && m.text.includes(`任务图 #${simple.data.graph.id}`));
      expect(deliveryMsg, "delivery wakeup must be emitted").toBeDefined();
      expect(deliveryMsg!.text).not.toContain("比如审查");
      expect(deliveryMsg!.text).not.toContain("审查");
    } finally {
      fx.close();
    }
  });

  it("S4: hub graph finish completes cleanly when an OPEN PR exists, notes the open PR, and keeps --unmerged-ok as a compatible no-op", async () => {
    const fx = createPmFrictionFixture();
    try {
      const runGraphWithOpenPr = async (unmergedOk: boolean) => {
        const created = fx.createGraph({
          title: unmergedOk ? "compat flag graph" : "default open pr graph",
          goal: "Open a PR for human review.",
          steps: [{ key: "impl", title: "implement", brief: "Open a PR." }],
        });
        const node = created.data.graph.nodes[0]!;
        await fx.startWorktree(node.activeWorkerId!);
        const branch = fx.ledger.hubCall(fx.lin.sessionId, "worker.show", { workerId: node.activeWorkerId! }).data.worker.branch!;
        fx.workerTurn(
          node.activeWorkerId!,
          reportBlock({ status: "做完了", summary: "Opened PR.", pr: "https://example.test/pull/42" }),
        );
        return fx.ledger.hubCall(
          fx.lin.sessionId,
          "graph.finish",
          {
            graphId: created.data.graph.id,
            summary: "Ready for human PR review.",
            ...(unmergedOk ? { unmergedOk: true } : {}),
          },
          {
            graphPrs: {
              [branch]: { number: 42, state: "OPEN", url: "https://example.test/pull/42" },
            },
          },
        );
      };

      const defaultFinish = await runGraphWithOpenPr(false);
      expect(defaultFinish.data.graph.status).toBe("completed");
      expect(defaultFinish.text).toContain("https://example.test/pull/42");

      const compatFinish = await runGraphWithOpenPr(true);
      expect(compatFinish.data.graph.status).toBe("completed");
    } finally {
      fx.close();
    }
  });

  it("S5: Worker report placeholders, Worker rules, and handover prompt drop repo-specific ceremony while keeping 9 report keys", () => {
    const cwd = makeTempDir();
    expect(WORKER_REPORT_FORMAT).not.toContain("或者建议改哪个记忆文件");
    expect(WORKER_REPORT_FORMAT).not.toContain("方案、验收结论、截图、录屏");

    for (const vendor of AGENT_VENDORS) {
      const prompt = buildWorkerSystemPrompt({ ...workerContext(), vendor }, cwd);
      expect(prompt, vendor).not.toContain("等别的 PR 合并");
      expect(prompt, vendor).not.toContain("方案、验收结论、截图、录屏");
      expect(prompt, vendor).not.toContain("或者建议改哪个记忆文件");
    }

    const handover = handoverRequestText({ auto: true, transcriptPath: null, forked: false });
    expect(handover).not.toContain("在跑的 Worker 和 PR");
  });

  it("S6: prompt-policy detects every workflow-overfit rule, allows opt-in descriptions, handles dirty/large inputs, and passes all shipped surfaces", () => {
    expect(WORKFLOW_OVERFIT_RULE_IDS).toEqual([
      "unrequested-review-trigger",
      "fixed-dev-pipeline",
      "forced-cross-vendor-review",
      "unrequested-memory-nomination",
      "fixed-acceptance-ceremony",
    ]);

    const overfitSamples: ReadonlyArray<readonly [WorkflowOverfitRuleId, string]> = [
      ["unrequested-review-trigger", "项目要求审查或改动风险较高而还没审查的，交付前按任务图手册补一个独立审查步骤。"],
      ["unrequested-review-trigger", "不读代码 diff，代码质量由审查负责。"],
      ["unrequested-review-trigger", "项目规矩或用户要求、但没画进图的步骤（比如审查），后台看不出来。"],
      ["fixed-dev-pipeline", "比如一个稍复杂的任务，拆成「写方案 → 写代码 → 审查」即可。"],
      ["fixed-dev-pipeline", "不要把一个需求切成前端、后端各一个 Worker。"],
      ["forced-cross-vendor-review", "提醒：审查步骤「review」和上游「impl」是同一家模型（claude）。"],
      ["unrequested-memory-nomination", "问题: 无 | <要项目经理回答什么，或者建议改哪个记忆文件>"],
      ["fixed-acceptance-ceremony", "要足以说服你的领导相信你完美实现了这个功能"],
      ["fixed-acceptance-ceremony", "发一张以“请验收”开头的汇报卡到总助（不把路径写进卡片标题，也不贴到 PR 评论里代替）。"],
    ];

    for (const [expectedId, sample] of overfitSamples) {
      const violations = workflowOverfitViolationsIn(sample);
      expect(violations.map((v) => v.rule.id), sample).toContain(expectedId);
      const formatted = describeWorkflowOverfitViolation(sample, violations[0]!);
      expect(formatted).toContain(`[${expectedId}]`);
      expect(formatted).not.toContain("\n");
    }

    const optInSamples = [
      "只在用户要求或项目自身规矩明确需要时安排独立审查步骤（设 \"review\": true）。",
      "需要隔离检出与防篡改校验的独立审查，可在任务图中使用审查步骤。",
      "这一步是独立审查：只查不修，你不是作者。",
    ];
    for (const sample of optInSamples) {
      expect(workflowOverfitViolationsIn(sample), sample).toEqual([]);
    }

    expect(workflowOverfitViolationsIn("")).toEqual([]);
    expect(workflowOverfitViolationsIn("\u0000\u0007\n\r".repeat(50))).toEqual([]);
    expect(workflowOverfitViolationsIn("普通说明。".repeat(12_000))).toEqual([]);

    const cwd = makeTempDir();
    expect(auditShippedPromptSurfaces(collectShippedSurfaces(cwd))).toEqual([]);
  });
});

describe("regression: unchanged platform guarantees (must pass before and after implementation)", () => {
  it("R1: prompt-cache prefix stays byte-identical across Worker tasks and unchanged on PM persona/mode edits", () => {
    const cwd = makeTempDir();
    for (const vendor of AGENT_VENDORS) {
      const w1 = buildWorkerSystemPrompt({ ...workerContext(), vendor }, cwd);
      const w2 = buildWorkerSystemPrompt(
        {
          ...workerContext({
            id: 77,
            title: "different task",
            task: "Completely different task body.",
            workspace: "main",
            worktreePath: null,
            branch: null,
            readonly: true,
            takeoverOf: 11,
          }),
          vendor,
        },
        cwd,
      );
      expect(w2, vendor).toBe(w1);

      const baseCtx = projectContext({ pm: { id: 1, name: "小林", mode: "manage_only", vendor, persona: "" } });
      const editedCtx = projectContext({ pm: { id: 1, name: "小林", mode: "hands_on", vendor, persona: "自定义流程偏好" } });
      const fpBase = launchFingerprint({
        prompt: buildFingerprintPrompt(baseCtx, cwd),
        settings: "",
        skills: taskGraphSkillCatalogEntry(),
      });
      const fpEdited = launchFingerprint({
        prompt: buildFingerprintPrompt(editedCtx, cwd),
        settings: "",
        skills: taskGraphSkillCatalogEntry(),
      });
      expect(fpEdited, vendor).toBe(fpBase);
    }

    const note = personaUpdateNote({
      revision: 2,
      vendor: "claude",
      persona: { text: "每次改动都先写方案。", bySelf: false },
      mode: null,
    });
    expect(note).toContain("每次改动都先写方案。");
    expect(taskGraphSkillMarkdown()).toBe(taskGraphSkillMarkdown());
    expect(taskGraphSkillMarkdown()).not.toMatch(/\d{4}-\d{2}-\d{2}|\/launch\//u);
  });

  it("R2: Worker 9-field report parser and optional review protocol remain backward-compatible", () => {
    const raw = [
      "=== 汇报 ===",
      "状态: 做完了",
      "摘要: 完成接口调整",
      "PR: 无",
      "提交: abcdef1",
      "测试: 通过",
      "偏离: 无",
      "交棒: 无",
      "文件: 无",
      "问题: 无",
      "=== 汇报结束 ===",
    ].join("\n");
    const parsed = parseWorkerReport(raw);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.report.status).toBe("done");
      expect(parsed.report.commit).toBe("abcdef1");
      expect(parsed.report.pr).toBeNull();
    }

    expect(parseWorkerReport("malformed output without markers").kind).toBe("unformatted");
    expect(parseReviewVerdict("PASS")).toBe("PASS");
    expect(parseReviewVerdict("FAIL")).toBe("FAIL");
    const legacyVerdict: StoredReviewVerdict = "PASS+NOTES";
    expect(legacyVerdict).toBe("PASS+NOTES");
    expect(REVIEW_CHECKLIST).toContain("只查不修");
    expect(REVIEW_CHECKLIST).toContain("PASS | FAIL");
  });

  it("R3: core PM mechanics (role hierarchy, modes, hub ask cards, checklist rule, memory, no subagents) stay intact", () => {
    const cwd = makeTempDir();
    for (const vendor of AGENT_VENDORS) {
      for (const mode of PM_MODES) {
        const prompt = buildLaunchPrompt(
          projectContext({ pm: { id: 1, name: "小林", mode, vendor, persona: "" } }),
          cwd,
        );
        expect(prompt).toContain("总助（Router） → 你（项目经理） → Worker");
        expect(prompt).toContain("# 进度清单");
        expect(prompt).toContain("# 怎么记事情");
        expect(prompt).toContain("`hub ask`");
        expect(prompt).toContain("不用厂商自带的子代理");
        expect(prompt).toContain("`hub models`");
      }
      const workerPrompt = buildWorkerSystemPrompt({ ...workerContext(), vendor }, cwd);
      expect(workerPrompt).toContain("# 进度清单");
      expect(workerPrompt).toContain("不用厂商自带的子代理");
    }
    expect(AGENTS_NOTE).toContain("AGENTS.md");
    const firstMsg = buildWorkerFirstMessage({
      project: card(1, "demo", "/work/demo"),
      worker: workerContext().worker!,
      task: "Run targeted check.",
    });
    expect(firstMsg).toContain("Run targeted check.");
  });

  it("R4: cross-platform stdin shell note and hub CLI command registry stay consistent", () => {
    expect(STDIN_SHELL_NOTE).toContain("bash、zsh");
    expect(STDIN_SHELL_NOTE).toContain("PowerShell");
    for (const command of HUB_COMMANDS) {
      expect(HUB_USAGE, command).toContain(`hub ${command.replace(".", " ")}`);
    }
  });

  it("R5: Router and Project Catalog prompts remain workflow-neutral and well-formed", () => {
    const router = buildRouterSystemPrompt();
    const catalog = buildCatalogSystemPrompt();
    expect(router).toContain("--verbatim");
    expect(router).not.toContain("拆成「写方案 → 写代码 → 审查」");
    expect(catalog).toContain('"oneLiner"');
    expect(catalog).not.toContain("快去审查");
  });
});
