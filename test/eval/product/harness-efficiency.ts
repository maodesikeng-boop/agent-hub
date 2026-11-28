// Tier 1 efficiency scenarios verifying prompt-cache prefix stability across Bellwood's real src/ resident and first_message channels.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { takePendingBatch } from "../../../src/daemon/driver/driver-helpers.ts";
import { takePersonaNote } from "../../../src/daemon/driver/persona-note.ts";
import { MemorySessionStore } from "../../../src/daemon/driver/test-helpers.ts";
import { createLedger } from "../../../src/daemon/ledger/index.ts";
import { buildLaunchPrompt, personaUpdateNote } from "../../../src/daemon/prompt.ts";
import { openDatabase } from "../../../src/daemon/store/db.ts";
import { migrate } from "../../../src/daemon/store/migrate.ts";
import {
  EMPTY_TOKEN_USAGE,
  vendorSpec,
  type AgentSessionRow,
  type DriverEvent,
  type LaunchFiles,
} from "../../../src/shared/index.ts";
import { appendDeliverySuffix } from "../../../src/shared/pm-agenda.ts";
import { createAcpDriver } from "../../../src/vendors/_common/acp/index.ts";
import { readAcpSystemPrompt } from "../../../src/vendors/_common/acp/protocol.ts";
import { readJsonLog } from "../../append-log.ts";
import type { CheckResult } from "../types.ts";
import {
  checkPromptPrefixStability,
  normalizeContextSnapshot,
  startMockModelServer,
} from "./mock-model-server.ts";
import type { EvalScenarioSpec, TrialOutcome } from "./types.ts";

const FAKE_ACP_AGENT = fileURLToPath(
  new URL("../../../src/vendors/_common/acp/fixtures/fake-acp-agent.ts", import.meta.url),
);

function makeEfficiencyOutcome(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha256: string,
  checks: readonly CheckResult[],
  prefixStable: boolean,
): TrialOutcome {
  return {
    scenarioId: spec.id,
    dimension: spec.dimension,
    suite: spec.suite,
    split: spec.split,
    versionLabel: "head",
    commit,
    vendor: "claude",
    model: "tier1-mock",
    effort: null,
    trialIndex: 0,
    envError: null,
    checks,
    efficiency: {
      turns: 2,
      toolCalls: checks.length,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 80,
      cacheReadRatio: 0.8,
      prefixStable,
    },
    promptSha256: null,
    graderSha256,
  };
}

export async function runResidentEfficiencyScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
  workDir: string,
): Promise<TrialOutcome> {
  const resRoot = join(workDir, "eff-resident");
  const projDir = join(resRoot, "proj");
  mkdirSync(projDir, { recursive: true });
  const db = openDatabase(join(resRoot, "resident.sqlite"));
  migrate(db);
  const ledger = createLedger(db, { pmHomeRoot: join(resRoot, "pm-home"), dataHome: join(resRoot, "data") });
  const server = await startMockModelServer({
    turns: [{ text: "resident reply 1" }, { text: "resident reply 2" }],
  });

  try {
    const pm = ledger.createPm({
      name: "Resident Eval PM",
      mode: "manage_only",
      vendor: "claude",
      persona: "Prefer concise evidence-first replies.",
      folder: projDir,
    });
    const launchCtx1 = ledger.getLaunchContext(pm.sessionId);
    const systemPrompt = buildLaunchPrompt(launchCtx1, projDir);
    const holder = { personaSeen: launchCtx1.pm.personaRevision ?? 0 };

    const post1 = ledger.postUserMessage({
      conversationId: pm.conversation.id,
      clientId: "res-1",
      text: "Turn one: inspect tests",
    });
    const msg1 = ledger.getMessage(post1.messageId)!;
    const deliv1 = ledger.deliveryOf(msg1);
    const batch1 = takePendingBatch(
      [{ messageIds: [msg1.id], source: "user", text: deliv1.text, prefixes: deliv1.prefixes, resend: false }],
      () => false,
    )!.taken;
    const suffix1 = ledger.deliverySuffix?.(pm.sessionId, batch1.messageIds)?.text ?? "";
    const turn1Text = appendDeliverySuffix([...batch1.body.prefixes, batch1.body.text].join("\n"), suffix1);

    const r1 = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-mock",
        instructions: systemPrompt,
        prompt_cache_key: `resident-pm-${pm.sessionId}`,
        tools: [{ type: "function", name: "Bash" }],
        input: [{ role: "user", content: turn1Text }],
      }),
    });
    await r1.text();

    // Mid-session persona edit + Task Graph creation must append into Turn 2 user input, never mutate systemPrompt.
    ledger.editPersona(
      pm.pm.id,
      { text: "Prefer concise evidence-first replies.\n- Always attach verification evidence.", reason: "tier1 habit" },
      { kind: "user" },
    );
    ledger.hubCall(pm.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "Resident agenda check", nodes: [{ key: "verify", title: "Verify" }] }),
    });

    const takenPersona = takePersonaNote(
      (sid, since) => {
        const upd = ledger.personaUpdate(sid, since);
        return upd === null ? null : { revision: upd.revision, note: personaUpdateNote(upd) };
      },
      pm.sessionId,
      holder,
      () => {},
      () => {},
    );
    const post2 = ledger.postUserMessage({
      conversationId: pm.conversation.id,
      clientId: "res-2",
      text: "Turn two: continue",
    });
    const msg2 = ledger.getMessage(post2.messageId)!;
    const deliv2 = ledger.deliveryOf(msg2);
    const batch2 = takePendingBatch(
      [{ messageIds: [msg2.id], source: "user", text: deliv2.text, prefixes: deliv2.prefixes, resend: false }],
      () => false,
    )!.taken;
    const suffix2 = ledger.deliverySuffix?.(pm.sessionId, batch2.messageIds)?.text ?? "";
    const turn2Prefixes = [...(takenPersona ? [takenPersona.note] : []), ...batch2.body.prefixes];
    const turn2Text = appendDeliverySuffix([...turn2Prefixes, batch2.body.text].join("\n"), suffix2);

    const r2 = await fetch(`${server.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-mock",
        instructions: systemPrompt,
        prompt_cache_key: `resident-pm-${pm.sessionId}`,
        tools: [{ type: "function", name: "Bash" }],
        input: [
          { role: "user", content: turn1Text },
          { role: "assistant", content: "resident reply 1" },
          { role: "user", content: turn2Text },
        ],
      }),
    });
    await r2.text();

    const recorded = server.requests();
    const stableReport = checkPromptPrefixStability(recorded);
    const rebakedSystemPrompt = buildLaunchPrompt(ledger.getLaunchContext(pm.sessionId), projDir);
    const brokenReport = checkPromptPrefixStability([
      recorded[0]!,
      { ...recorded[1]!, systemText: rebakedSystemPrompt },
    ]);
    const realWorkHappened =
      takenPersona !== null &&
      turn2Text.includes("Always attach verification evidence.") &&
      suffix2.length > 0 &&
      rebakedSystemPrompt !== systemPrompt;

    const snapshot = normalizeContextSnapshot(
      {
        ...recorded[0]!,
        systemText: `${recorded[0]!.systemText}\nPath /Users/alice/repo C:\\Users\\bob\\app 2026-11-28T02:00:00.000Z`,
      },
      { dynamicRoots: [workDir] },
    );
    const redactedOk =
      !snapshot.includes(workDir) &&
      !snapshot.includes("/Users/alice") &&
      !snapshot.includes("C:\\Users\\bob") &&
      snapshot.includes("<WORK_ROOT>") &&
      snapshot.includes("<USER_HOME>") &&
      snapshot.includes("<TIMESTAMP>");

    const checks: CheckResult[] = [
      {
        id: "EF1",
        title: "Real src/ resident prompt, takePersonaNote, and pm-delivery preserve prefix and catch rebake drift",
        status:
          realWorkHappened && stableReport.stable && !brokenReport.stable && brokenReport.firstDivergenceTurn === 1
            ? "pass"
            : "fail",
        reason: `srcPromptLen=${systemPrompt.length}, personaInjected=${takenPersona !== null}, agendaLen=${suffix2.length}, stable=${stableReport.stable}, rebakeCaughtTurn=${String(brokenReport.firstDivergenceTurn)}`,
        evidence: [],
      },
      {
        id: "EF2",
        title: "Model-visible context snapshot redacts real dynamic roots, cross-platform user paths, and timestamps",
        status: redactedOk ? "pass" : "fail",
        reason: redactedOk
          ? "Normalized snapshot redacted work root, user paths, and timestamps"
          : "Leak detected in snapshot",
        evidence: [],
      },
    ];
    return makeEfficiencyOutcome(spec, commit, graderSha, checks, realWorkHappened && stableReport.stable);
  } finally {
    await server.close();
    ledger.close();
    db.close();
  }
}

export async function runFirstMessageEfficiencyScenario(
  spec: EvalScenarioSpec,
  commit: string,
  graderSha: string,
  workDir: string,
): Promise<TrialOutcome> {
  const fmRoot = join(workDir, "eff-first-message");
  const projDir = join(fmRoot, "proj");
  const logDir = join(fmRoot, "logs");
  const stateDir = join(fmRoot, "state");
  for (const dir of [projDir, logDir, stateDir]) mkdirSync(dir, { recursive: true });
  const realProjDir = realpathSync(projDir);
  const scriptFile = join(logDir, "script.json");
  const logFile = join(logDir, "fake-acp.jsonl");
  const promptFile = join(fmRoot, "prompt.md");
  writeFileSync(
    scriptFile,
    JSON.stringify({ turns: [{ textChunks: ["first_message reply 1"] }, { textChunks: ["first_message reply 2"] }] }),
    "utf8",
  );

  const db = openDatabase(join(fmRoot, "first-msg.sqlite"));
  migrate(db);
  const ledger = createLedger(db, { pmHomeRoot: join(fmRoot, "pm-home"), dataHome: join(fmRoot, "data") });
  const store = new MemorySessionStore();
  const server = await startMockModelServer({
    turns: [{ text: "first_message reply 1" }, { text: "first_message reply 2" }],
  });

  const pm = ledger.createPm({
    name: "FirstMsg Eval PM",
    mode: "manage_only",
    vendor: "opencode",
    persona: "Initial first-message persona.",
    folder: realProjDir,
  });
  const launchCtx1 = ledger.getLaunchContext(pm.sessionId);
  const initialPrompt = buildLaunchPrompt(launchCtx1, realProjDir);
  writeFileSync(promptFile, initialPrompt, "utf8");

  const row: AgentSessionRow = {
    id: pm.sessionId,
    role: "pm",
    pmId: pm.pm.id,
    conversationId: pm.conversation.id,
    workerId: null,
    vendor: "opencode",
    vendorSessionId: "",
    cwd: realProjDir,
    addDirs: [],
    model: null,
    effort: null,
    status: "idle",
    pid: null,
    generation: 1,
    usage: { ...EMPTY_TOKEN_USAGE },
    rateLimit: null,
    personaRevision: launchCtx1.pm.personaRevision ?? 0,
    hasCompletedTurn: false,
    lastEventAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.add(row);

  const driver = createAcpDriver(
    {
      vendor: "opencode",
      launchArgs: [FAKE_ACP_AGENT],
    },
    {
      executablePath: process.execPath,
      store,
      idleCloseMs: 60_000,
      interruptGraceMs: 2_000,
      startTimeoutMs: 10_000,
      shutdownGraceMs: 3_000,
      log: () => {},
      prepareLaunch: async (session): Promise<LaunchFiles> => {
        const tmp = join(stateDir, "tmp", String(session.id));
        mkdirSync(tmp, { recursive: true });
        return {
          promptFile,
          tmpDir: tmp,
          fingerprint: "tier1-fp-v1",
          env: {
            FAKE_ACP_SCRIPT: scriptFile,
            FAKE_ACP_LOG: logFile,
            FAKE_ACP_STATE: stateDir,
            TMPDIR: tmp,
          },
        };
      },
      deliverySuffix: (sid, ids, preamble) => ledger.deliverySuffix?.(sid, ids, preamble) ?? { text: "" },
      personaNote: (sid, since) => {
        const upd = ledger.personaUpdate(sid, since);
        return upd === null ? null : { revision: upd.revision, note: personaUpdateNote(upd) };
      },
    },
  );

  const turnEndedEvents: Array<Extract<DriverEvent, { type: "turn.ended" }>> = [];
  const waiters: Array<() => void> = [];
  driver.onEvent((_sid, ev) => {
    if (ev.type === "turn.ended") {
      turnEndedEvents.push(ev);
      for (const wake of waiters.splice(0)) wake();
    }
  });
  const waitForTurnCount = async (target: number): Promise<void> => {
    while (turnEndedEvents.length < target) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };

  try {
    const post1 = ledger.postUserMessage({
      conversationId: pm.conversation.id,
      clientId: "fm-1",
      text: "Turn 1 on first_message channel",
    });
    const msg1 = ledger.getMessage(post1.messageId)!;
    const d1 = ledger.deliveryOf(msg1);
    await driver.send(pm.sessionId, { messageIds: [msg1.id], source: "user", text: d1.text, prefixes: d1.prefixes });
    await waitForTurnCount(1);

    // Mid-session persona edit + Task Graph creation must append on Turn 2 without re-injecting <system_instructions>.
    ledger.editPersona(
      pm.pm.id,
      { text: "Initial first-message persona.\n- Always verify first_message channel.", reason: "tier1 first_message habit" },
      { kind: "user" },
    );
    ledger.hubCall(pm.sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "First-message agenda", nodes: [{ key: "check", title: "Check" }] }),
    });

    const post2 = ledger.postUserMessage({
      conversationId: pm.conversation.id,
      clientId: "fm-2",
      text: "Turn 2 follow up",
    });
    const msg2 = ledger.getMessage(post2.messageId)!;
    const d2 = ledger.deliveryOf(msg2);
    await driver.send(pm.sessionId, { messageIds: [msg2.id], source: "user", text: d2.text, prefixes: d2.prefixes });
    await waitForTurnCount(2);

    const acpLogs = readJsonLog<{ event: string; turnIdx?: number; blocks?: string[] }>(logFile);
    const promptTurns = acpLogs.filter((e) => e.event === "session/prompt");
    const turn1Joined = (promptTurns[0]?.blocks ?? []).join("\n\n");
    const turn2Joined = (promptTurns[1]?.blocks ?? []).join("\n\n");

    const r1 = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "first-msg-mock",
        messages: [{ role: "user", content: turn1Joined }],
      }),
    });
    await r1.text();
    const r2 = await fetch(`${server.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "first-msg-mock",
        messages: [
          { role: "user", content: turn1Joined },
          { role: "assistant", content: "first_message reply 1" },
          { role: "user", content: turn2Joined },
        ],
      }),
    });
    await r2.text();

    const recorded = server.requests();
    const stableReport = checkPromptPrefixStability(recorded);
    const updatedPromptFile = join(fmRoot, "prompt-updated.md");
    writeFileSync(updatedPromptFile, buildLaunchPrompt(ledger.getLaunchContext(pm.sessionId), realProjDir), "utf8");
    const rebakedBlock = readAcpSystemPrompt(updatedPromptFile) ?? "";
    const brokenReport = checkPromptPrefixStability([
      recorded[0]!,
      {
        ...recorded[1]!,
        inputMessages: [
          { role: "user", content: `${rebakedBlock}\n\nTurn 1 on first_message channel` },
          ...recorded[1]!.inputMessages.slice(1),
        ],
      },
    ]);

    const acpContractOk =
      vendorSpec("opencode").capabilities.systemPrompt === "first_message" &&
      promptTurns.length === 2 &&
      turn1Joined.includes("<system_instructions>") &&
      turn1Joined.includes("FirstMsg Eval PM") &&
      !turn2Joined.includes("<system_instructions>") &&
      turn2Joined.includes("Always verify first_message channel.");

    const passed =
      acpContractOk &&
      stableReport.stable &&
      !brokenReport.stable &&
      brokenReport.violations.some((v) => v.kind === "input_prefix_mutated");

    const checks: CheckResult[] = [
      {
        id: "EF3",
        title: "Real AcpSessionDriver first_message channel preserves message-0 prefix and appends Turn 2 persona/agenda deltas",
        status: passed ? "pass" : "fail",
        reason: `acpTurns=${promptTurns.length}, t1HasSystem=${turn1Joined.includes("<system_instructions>")}, t2NoReinject=${!turn2Joined.includes("<system_instructions>")}, t2HasPersona=${turn2Joined.includes("Always verify first_message channel.")}, stable=${stableReport.stable}, driftCaught=${!brokenReport.stable}`,
        evidence: [],
      },
    ];
    return makeEfficiencyOutcome(spec, commit, graderSha, checks, acpContractOk && stableReport.stable);
  } finally {
    await driver.shutdown();
    await server.close();
    ledger.close();
    db.close();
  }
}
