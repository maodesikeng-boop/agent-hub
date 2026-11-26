import type { FakeScript, FakeSessionScript, FakeTurn } from "../fake-claude/fake-claude.ts";

export const BENCH_ECHO_REPLY = "bench echo ok";
export const BENCH_FAIL_REASON = "API Error: 529 bench scripted overload";
export const BENCH_ASK_QUESTION = "Bench question: pick one";
export const BENCH_ASK_OPTIONS = ["Bench yes", "Bench no"] as const;
export const BENCH_ASK_TRIGGER = "bench ask ";

export type BenchScenario = "echo" | "fail" | "ask";

export const scenarioMarker = (scenario: BenchScenario): string => `[bellwood-bench:${scenario}]`;

const echoTurn: FakeTurn = { steps: [{ text: BENCH_ECHO_REPLY }] };

const SCENARIO_SCRIPTS: Readonly<Record<BenchScenario, FakeScript>> = {
  echo: { defaultTurn: echoTurn },
  fail: { defaultTurn: { steps: [{ apiRetry: { attempt: 1, maxRetries: 1, errorStatus: 529, error: "overloaded" } }], result: { subtype: "success", isError: true, result: BENCH_FAIL_REASON } } },
  ask: {
    inputTurns: [{
      textPrefix: BENCH_ASK_TRIGGER,
      turn: {
        steps: [
          { bash: `printf '%s' '${BENCH_ASK_QUESTION}' | hub ask ${BENCH_ASK_OPTIONS.map((o) => `--option '${o}'`).join(" ")} --recommended '${BENCH_ASK_OPTIONS[0]}' --stdin` },
          { text: "Asked the owner." },
        ],
      },
    }],
    defaultTurn: echoTurn,
  },
};

export function benchFakeScript(): FakeScript {
  const sessions: FakeSessionScript[] = (Object.keys(SCENARIO_SCRIPTS) as BenchScenario[]).map((scenario) => ({
    promptIncludes: [scenarioMarker(scenario)],
    script: SCENARIO_SCRIPTS[scenario],
  }));
  return { defaultTurn: echoTurn, sessions };
}
