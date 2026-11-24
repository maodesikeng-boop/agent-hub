import { cn } from "../lib/utils.ts";

/**
 * Postcondition: renders a round ink count (99+ past 99) that pops once when the count changes; callers place it and
 * add the 2px halo in the colour of the surface behind it.
 */
export function CountPill({ count, testId, className }: { count: number; testId?: string; className?: string }) {
  return (
    <span
      key={count}
      data-testid={testId}
      aria-hidden="true"
      className={cn(
        "badge-pop grid h-4.5 min-w-4.5 place-items-center rounded-full bg-rail-ink px-1.25 text-xs leading-none font-semibold text-primary-foreground tabular-nums",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
