import { createContext, useContext, useState, type ReactNode } from "react";
import type { CapabilityScope, Pm, PmId } from "../../shared/index.ts";
import { capabilityProjectOptions, capabilityScopeKey, capabilitySections, capabilityTotals, useCapabilitiesView, useCustomizedCapabilityPms } from "../capabilities-model.ts";
import { SettingsNavRow } from "../mobile/settings/SettingsNavRow.tsx";
import { CapabilitiesPanel, countLabel } from "./CapabilitiesPanel.tsx";
import { CapabilityScopeSwitch, type CapabilityScopeChoice } from "./CapabilityScopeSwitch.tsx";
import { SettingsGroup } from "./SettingsList.tsx";

const CapabilityProjectsContext = createContext<readonly Pm[]>([]);

export function CapabilityProjects({ pms, children }: { pms: readonly Pm[]; children: ReactNode }) {
  return <CapabilityProjectsContext.Provider value={pms}>{children}</CapabilityProjectsContext.Provider>;
}

export function CapabilitiesSettings() {
  const projects = capabilityProjectOptions(useContext(CapabilityProjectsContext));
  const customized = useCustomizedCapabilityPms();
  const [choice, setChoice] = useState<CapabilityScopeChoice>("default");
  const [pmId, setPmId] = useState<PmId | null>(null);
  const project = projects.find((p) => p.pmId === pmId) ?? projects[0] ?? null;
  const scope: CapabilityScope = choice === "pm" && project !== null ? { kind: "pm", pmId: project.pmId } : { kind: choice === "router" ? "router" : "default" };
  return (
    <>
      <CapabilityScopeSwitch choice={scope.kind} project={project} projects={projects} customized={customized} onChoice={setChoice} onProject={setPmId} />
      <CapabilitiesPanel key={capabilityScopeKey(scope)} scope={scope} lead={scope.kind === "pm" ? (project?.vendor ?? null) : null} onEditDefaults={() => setChoice("default")} />
    </>
  );
}

export function CapabilitiesEntry({ pmId, onOpen }: { pmId: PmId; onOpen: () => void }) {
  const { data: view } = useCapabilitiesView({ kind: "pm", pmId });
  const totals = view === undefined ? null : capabilityTotals(capabilitySections(view));
  return (
    <SettingsGroup title="Capabilities">
      <SettingsNavRow label="Plugins, skills, and MCP servers" {...(totals !== null && totals.total > 0 ? { summary: countLabel(totals.enabled, totals.total) } : {})} onClick={onOpen} />
    </SettingsGroup>
  );
}
