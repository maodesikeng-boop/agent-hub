import { resolvePmLook } from "../../shared/slimes.ts";
import type { Pm } from "../../shared/index.ts";
import { Button } from "../ui/button.tsx";
import { ArrowLeft } from "../ui/icons.ts";
import { Avatar } from "./Avatar.tsx";
import { CapabilitiesPanel } from "./CapabilitiesPanel.tsx";

export function ProjectCapabilitiesPage({ pm, onBack, onEditDefaults }: { pm: Pm; onBack: () => void; onEditDefaults: () => void }) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={`${pm.name}'s capabilities`}>
      <header data-window-drag className="flex h-16 min-w-0 shrink-0 items-center gap-3 overflow-hidden px-6">
        <Button variant="slot" size="icon" className="shrink-0" aria-label="Back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
        </Button>
        <Avatar look={resolvePmLook(pm)} size={34} />
        <span title={pm.name} className="min-w-0 truncate text-title leading-snug font-semibold">
          {pm.name}
        </span>
      </header>
      <div className="page-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-6 pt-4 pb-12">
        <div className="mx-auto grid max-w-160 grid-cols-1 gap-6">
          <h1 className="px-4 text-display leading-tight font-semibold tracking-tight">Capabilities</h1>
          <CapabilitiesPanel scope={{ kind: "pm", pmId: pm.id }} lead={pm.vendor} onEditDefaults={onEditDefaults} />
        </div>
      </div>
    </section>
  );
}
