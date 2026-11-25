import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hubPath, type HubArgs, type HubCommand } from "../../shared/hub.ts";
import type { WorkerId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { createSessionTokens } from "../agent-api/tokens.ts";
import { createAgentApi, type AgentApiOptions } from "../agent-api/server.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type LedgerOptions } from "./index.ts";

export function workerOpsFixture(extra: Partial<LedgerOptions> = {}) {
  let now = Date.parse("2026-11-25T09:00:00Z");
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "bellwood-worker-ops-")));
  const folder = join(root, "repo");
  const dataHome = join(root, "state");
  mkdirSync(folder);
  const db = openTestDb();
  const ledger = createLedger(db, {
    now: () => now, dataHome,
    pmHomeRoot: join(dataHome, "pm-home"), worktreesDir: join(dataHome, "worktrees"),
    resolveFolder: createResolveFolder({ dataHome, userHome: root }), osSandboxed: () => true,
    ...extra,
  });
  const pm = ledger.createPm({ name: "PM", vendor: "claude", mode: "manage_only", persona: "" });
  const project = ledger.hubCall(pm.sessionId, "project.create", { folder }).data.project;
  const hub = <C extends HubCommand>(command: C, args: HubArgs<C>) => ledger.hubCall(pm.sessionId, command, args);
  const sessionOf = (id: WorkerId) => db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ? ORDER BY generation DESC LIMIT 1", id)!.id;
  const messageOf = (id: WorkerId) => db.get<{ id: number }>("SELECT id FROM messages WHERE session_id = ? AND sender = 'pm' ORDER BY id DESC LIMIT 1", sessionOf(id))!.id;
  const advance = (ms: number) => { now += ms; };
  const emit = (id: WorkerId, event: DriverEvent) => ledger.applyDriverEvent(sessionOf(id), event);
  const begin = (workerId: WorkerId) => {
    const id = messageOf(workerId);
    emit(workerId, { type: "message.delivered", messageIds: [id], at: now });
    emit(workerId, { type: "message.processing", messageIds: [id], at: now });
    return id;
  };
  const end = (workerId: WorkerId, extra: Partial<Extract<DriverEvent, { type: "turn.ended" }>> = {}) =>
    emit(workerId, { type: "turn.ended", messageIds: [messageOf(workerId)], at: now, ok: true, interrupted: false, durationMs: 1, ...extra });
  let app: FastifyInstance | undefined;
  return {
    db, ledger, pm, project, root, folder, hub, sessionOf, messageOf, advance, emit, begin, end, now: () => now,
    api(options: Partial<AgentApiOptions> = {}) {
      const tokens = createSessionTokens();
      const token = tokens.issue(pm.sessionId);
      const api = createAgentApi({ ledger, tokens, ...options });
      app = api;
      return (command: HubCommand, payload: object) =>
        api.inject({ method: "POST", url: hubPath(command), payload, headers: { authorization: `Bearer ${token}` } });
    },
    async close() {
      await app?.close();
      ledger.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
