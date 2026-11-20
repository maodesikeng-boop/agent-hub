import {
  INHERIT_WORKER_CAPABILITIES,
  parseWorkerCapabilitiesJson,
  workerCapabilitiesJson,
  type WorkerCapabilities,
} from "../../shared/pm-capabilities.ts";
import type { Db } from "../store/index.ts";

export type CapabilityOwner = { table: "worker_capabilities"; workerId: number } | { table: "task_graph_step_capabilities"; stepId: number };

function ownerOf(owner: CapabilityOwner): { table: string; column: string; id: number } {
  return owner.table === "worker_capabilities"
    ? { table: owner.table, column: "worker_id", id: owner.workerId }
    : { table: owner.table, column: "step_id", id: owner.stepId };
}

export function readWorkerCapabilities(db: Db, owner: CapabilityOwner): WorkerCapabilities {
  const { table, column, id } = ownerOf(owner);
  const row = db.get<{ capabilities_json: string }>(`SELECT capabilities_json FROM ${table} WHERE ${column} = ?`, id);
  return row === undefined ? INHERIT_WORKER_CAPABILITIES : parseWorkerCapabilitiesJson(row.capabilities_json);
}

export function writeWorkerCapabilities(db: Db, owner: CapabilityOwner, caps: WorkerCapabilities): void {
  const { table, column, id } = ownerOf(owner);
  const json = workerCapabilitiesJson(caps);
  if (json === null) {
    db.run(`DELETE FROM ${table} WHERE ${column} = ?`, id);
    return;
  }
  db.run(
    `INSERT INTO ${table} (${column}, capabilities_json) VALUES (?, ?)
     ON CONFLICT (${column}) DO UPDATE SET capabilities_json = excluded.capabilities_json`,
    id,
    json,
  );
}
