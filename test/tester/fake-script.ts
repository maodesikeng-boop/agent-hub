// The fake claude's script for bench runs in fake mode. Each bench PM carries a marker in its persona, which lands in
// its system prompt, so one script answers each scenario the same way no matter how many turns ran before.
import type { FakeScript, FakeSessionScript, FakeTurn } from "../fake-claude/fake-claude.ts";

export const BENCH_ECHO_REPLY = "bench echo ok";
export const BENCH_FAIL_REASON = "API Error: 529 bench scripted overload";
export const BENCH_ASK_QUESTION = "Bench question: pick one";
export const BENCH_ASK_OPTIONS = ["Bench yes", "Bench no"] as const;

export type BenchScenario = "echo" | "fail" | "ask";

export const scenarioMarker = (scenario: BenchScenario): string => `[bellwood-bench:${scenario}]`;

const echoTurn: FakeTurn = { steps: [{ text: BENCH_ECHO_REPLY }] };

const SCENARIO_TURNS: Readonly<Record<BenchScenario, FakeTurn>> = {
  echo: echoTurn,
  fail: { steps: [{ apiRetry: { attempt: 1, maxRetries: 1, errorStatus: 529, error: "overloaded" } }], result: { subtype: "success", isError: true, result: BENCH_FAIL_REASON } },
  ask: {
    steps: [
      { bash: `printf '%s' '${BENCH_ASK_QUESTION}' | hub ask ${BENCH_ASK_OPTIONS.map((o) => `--option '${o}'`).join(" ")} --recommended '${BENCH_ASK_OPTIONS[0]}' --stdin` },
      { text: "Asked the owner." },
    ],
  },
};

export function benchFakeScript(): FakeScript {
  const sessions: FakeSessionScript[] = (Object.keys(SCENARIO_TURNS) as BenchScenario[]).map((scenario) => ({
    promptIncludes: [scenarioMarker(scenario)],
    script: { defaultTurn: SCENARIO_TURNS[scenario] },
  }));
  return { defaultTurn: echoTurn, sessions };
}
