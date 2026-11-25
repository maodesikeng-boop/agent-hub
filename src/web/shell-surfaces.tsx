import type { ReactNode } from "react";

// Invariant: a surface's React tree lives under its <Surface> in the host, so mounting and unmounting outlets in any layout
// moves the surface's element and never remounts what it renders.

export type SettingsSurface = "capabilities" | "resources" | "account" | "provider-sheet";

export type SurfaceId = "list" | "router" | "conversation" | "panel" | "worker" | `settings:${SettingsSurface}`;

/**
 * Precondition: rendered once above both layouts and above the surface host.
 * Postcondition: owns one element per SurfaceId for its lifetime and drops them when it unmounts.
 */
export function SurfaceScope(_props: { children: ReactNode }): ReactNode {
  throw new Error("Not implemented");
}

/**
 * Precondition: inside a SurfaceScope; at most one Surface per id is mounted.
 * Postcondition: renders children into the id's element. Children keep their state while this Surface stays mounted with the
 * same React key, however outlets for the id mount, unmount, or move. While no outlet shows the id, children stay mounted
 * inside a hidden <Activity>: state is kept and effects are cleaned up until an outlet shows it again.
 */
export function Surface(_props: { id: SurfaceId; children: ReactNode }): ReactNode {
  throw new Error("Not implemented");
}

/**
 * Precondition: inside a SurfaceScope, before the surface host in tree order; at most one outlet per id is mounted after a
 * commit.
 * Postcondition: while mounted, the id's element is its only child, so the surface's layout effects see it attached. When focus
 * was inside the surface before a move, the same element has focus after it.
 */
export function SurfaceOutlet(_props: { id: SurfaceId; className?: string }): ReactNode {
  throw new Error("Not implemented");
}
