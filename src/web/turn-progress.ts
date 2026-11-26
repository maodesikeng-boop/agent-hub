import { activeChecklistItemId, checklistOf, type ChecklistItem, type Message } from "../shared/index.ts";

export interface ChecklistStepView {
  item: ChecklistItem;
  process: readonly Message[];
}

export interface TurnProgressModel {
  /** The newest checklist snapshot, or null when the turn has no checklist. */
  steps: readonly ChecklistStepView[] | null;
  unassigned: readonly Message[];
}

const empty: TurnProgressModel = { steps: null, unassigned: [] };
const cache = new WeakMap<Message, { work: readonly Message[]; checklists: readonly Message[]; model: TurnProgressModel }>();
const sameMessages = (a: readonly Message[], b: readonly Message[]) => a === b || (a.length === b.length && a.every((row, i) => row === b[i]));

function buildProgress(work: readonly Message[], checklists: readonly Message[]): TurnProgressModel {
  const snapshots = checklists.flatMap((row) => {
    const items = checklistOf(row);
    return items === null ? [] : [{ id: row.id, items }];
  });
  const items = snapshots.at(-1)?.items;
  if (!items?.length) return { steps: items ? [] : null, unassigned: work };

  const steps = items.map<{ item: ChecklistItem; process: Message[] }>((item) => ({ item, process: [] }));
  const byId = new Map(steps.map((step) => [step.item.id, step]));
  let cursor = 0;
  let owner = steps[0]!;
  for (const row of work) {
    for (let snap = snapshots[cursor]; snap !== undefined && snap.id < row.id; snap = snapshots[++cursor]) {
      const active = activeChecklistItemId(snap.items);
      if (active !== null) owner = byId.get(active) ?? owner;
    }
    owner.process.push(row);
  }
  return { steps, unassigned: [] };
}

/** Attribute activity by message order while keeping the latest statuses and titles. */
export function turnProgress(work: readonly Message[], checklists: readonly Message[]): TurnProgressModel {
  const anchor = work[0] ?? checklists[0];
  if (!anchor) return empty;
  const cached = cache.get(anchor);
  if (cached && sameMessages(cached.work, work) && sameMessages(cached.checklists, checklists)) return cached.model;
  const model = buildProgress(work, checklists);
  cache.set(anchor, { work, checklists, model });
  return model;
}
