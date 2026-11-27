import { formatAgo, formatArchiveRemaining } from "../format.ts";
import { MINUTE_TICK_MS } from "../limits.ts";
import { useNow } from "../useNow.ts";

export function TimeAgo({ at }: { at: number }) {
  return formatAgo(at, useNow(MINUTE_TICK_MS));
}

export function ArchiveRemaining({ archivedAt }: { archivedAt: number }) {
  return formatArchiveRemaining(archivedAt, useNow(MINUTE_TICK_MS));
}
