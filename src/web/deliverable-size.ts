import { groupDeliverables, type Deliverable } from "../shared/index.ts";

export const DELIVERABLE_MEDIA_HEIGHT_REM = 6;

export const DELIVERABLE_DOC_ROW_HEIGHT_REM = 1.35;

export const DELIVERABLE_BLOCK_GAP_REM = 0.5;

export function deliverablesHeightRem(deliverables: readonly Deliverable[]): number {
  if (deliverables.length === 0) return 0;
  const { documents, media } = groupDeliverables(deliverables);
  const rows = (documents.length > 0 ? DELIVERABLE_DOC_ROW_HEIGHT_REM : 0) + (media.length > 0 ? DELIVERABLE_MEDIA_HEIGHT_REM : 0);
  const gaps = DELIVERABLE_BLOCK_GAP_REM * (documents.length > 0 && media.length > 0 ? 2 : 1);
  return rows + gaps;
}
