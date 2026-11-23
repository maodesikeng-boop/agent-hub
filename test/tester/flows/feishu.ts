// Runners for Feishu flows. Each sends as the owner through the driver and judges only what Feishu itself returns.
import type { FlowContext, FlowObservation, FlowRunner } from "../types.ts";

async function dmRouter(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function groupRoundTrip(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function failedTurnCard(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function offlineInboxReplay(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function reconnectCatchUp(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function hubFailover(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

async function desktopAnswerSyncsCard(ctx: FlowContext): Promise<FlowObservation> {
  throw new Error("Not implemented");
}

export const feishuRunners: Readonly<Record<string, FlowRunner>> = {
  "feishu.dm-router": dmRouter,
  "feishu.group-round-trip": groupRoundTrip,
  "feishu.failed-turn-card": failedTurnCard,
  "feishu.offline-inbox-replay": offlineInboxReplay,
  "feishu.reconnect-catch-up": reconnectCatchUp,
  "feishu.hub-failover": hubFailover,
  "feishu.desktop-answer-syncs-card": desktopAnswerSyncsCard,
};
