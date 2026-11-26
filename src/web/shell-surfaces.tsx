import { Activity, createContext, use, useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type SettingsSurface = "capabilities" | "resources" | "account" | "providers" | "provider-sheet";
export type SurfaceId = "topbar" | "list" | "router" | "conversation" | "panel" | "worker" | "settings:mobile" | `settings:${SettingsSurface}`;

function createSurface() {
  const element = document.createElement("div");
  element.className = "contents";
  const listeners = new Set<() => void>();
  let outlet: HTMLElement | null = null;
  let focus: HTMLElement | null = null;
  return {
    element,
    shown: () => outlet !== null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    attach(next: HTMLElement) {
      if (outlet !== null) throw new Error("A workbench surface cannot have two outlets");
      outlet = next;
      next.append(element);
      const restore = focus;
      focus = null;
      if (restore !== null) {
        queueMicrotask(() => {
          if (element.isConnected && element.contains(restore)) restore.focus({ preventScroll: true });
        });
      }
      for (const listener of listeners) listener();
      return () => {
        const active = document.activeElement;
        focus = active instanceof HTMLElement && element.contains(active) ? active : null;
        element.remove();
        outlet = null;
        for (const listener of listeners) listener();
        // Only restore focus on a move within the same commit; reopening a hidden page is a separate action.
        const previous = focus;
        if (previous !== null) queueMicrotask(() => { if (focus === previous) focus = null; });
      };
    },
  };
}

const Surfaces = createContext<((id: SurfaceId) => ReturnType<typeof createSurface>) | null>(null);

export function SurfaceScope({ children }: { children: ReactNode }) {
  const [surfaceOf] = useState(() => {
    const surfaces = new Map<SurfaceId, ReturnType<typeof createSurface>>();
    return (id: SurfaceId) => {
      const existing = surfaces.get(id);
      if (existing !== undefined) return existing;
      const surface = createSurface();
      surfaces.set(id, surface);
      return surface;
    };
  });
  return <Surfaces.Provider value={surfaceOf}>{children}</Surfaces.Provider>;
}

function useSurface(id: SurfaceId) {
  const surfaceOf = use(Surfaces);
  if (surfaceOf === null) throw new Error("Workbench surfaces require a SurfaceScope");
  return surfaceOf(id);
}

export function Surface({ id, children, visible = true }: { id: SurfaceId; children: ReactNode; visible?: boolean }) {
  const surface = useSurface(id);
  const shown = useSyncExternalStore(surface.subscribe, surface.shown);
  return createPortal(<Activity mode={shown && visible ? "visible" : "hidden"}>{children}</Activity>, surface.element);
}

export function SurfaceOutlet({ id, className = "contents" }: { id: SurfaceId; className?: string }) {
  const surface = useSurface(id);
  const ref = useCallback((outlet: HTMLDivElement | null) => outlet === null ? undefined : surface.attach(outlet), [surface]);
  return <div ref={ref} className={className} />;
}
