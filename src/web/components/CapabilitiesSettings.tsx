import * as RadioGroup from "@radix-ui/react-radio-group";
import { createContext, useContext, useId, useMemo, useState, type ReactNode } from "react";
import type { CapabilitiesPatch, CapabilitiesView, CapabilityIsolation, CapabilityKind, Pm, PmId } from "../../shared/index.ts";
import {
  CAPABILITY_KIND_LABELS,
  CAPABILITY_KIND_ORDER,
  ISOLATION_LABELS,
  ROUTER_SCOPE_OPTION,
  capabilitySections,
  capabilityScopeOptions,
  capabilityTotals,
  enforcementRows,
  filterCapabilitySections,
  kindPatches,
  rowsPatches,
  useCapabilitiesView,
  useCapabilityEditor,
  type CapabilityKindSection,
  type CapabilityRow,
  type CapabilityScopeKey,
  type CapabilityScopeOption,
  type CapabilitySourceGroup,
  type EnforcementCell,
} from "../capabilities-model.ts";
import { errorText } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { SettingsNavRow } from "../mobile/settings/SettingsNavRow.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { ChevronRight, Loader2 } from "../ui/icons.ts";
import { Switch } from "../ui/switch.tsx";
import { Avatar } from "./Avatar.tsx";
import { RouterAvatar } from "./RouterAvatar.tsx";
import { SearchField } from "./SearchField.tsx";
import { CollapsibleGroup, RowError, SettingsGroup } from "./SettingsList.tsx";

interface CapabilityScopesValue {
  options: readonly CapabilityScopeOption[];
  requested: CapabilityScopeKey;
  request: (key: CapabilityScopeKey) => void;
}

const NO_SCOPES: CapabilityScopesValue = { options: [ROUTER_SCOPE_OPTION], requested: "router", request: () => {} };

const CapabilityScopesContext = createContext<CapabilityScopesValue>(NO_SCOPES);

export function CapabilityScopes({ pms, children }: { pms: readonly Pm[]; children: ReactNode }) {
  const [requested, request] = useState<CapabilityScopeKey>("router");
  const options = capabilityScopeOptions(pms);
  const value = useMemo(() => ({ options, requested, request }), [options, requested]);
  return <CapabilityScopesContext.Provider value={value}>{children}</CapabilityScopesContext.Provider>;
}

type ApplyPatches = (patches: readonly CapabilitiesPatch[]) => void;

const countLabel = (enabled: number, total: number) => `${enabled} of ${total}`;

const EMPTY_LABELS: Readonly<Record<CapabilityKind, string>> = { mcp: "No MCP servers found", skill: "No skills found", connector: "No connectors found" };

const COLUMN_LABELS: Readonly<Record<CapabilityKind, string>> = { mcp: "MCP", skill: "Skills", connector: "Connectors" };

const ISOLATION_DOTS: Readonly<Record<CapabilityIsolation, string>> = { session: "bg-success", tool_deny: "bg-caution", shared: "bg-muted-foreground/40" };

function ScopeStrip({ options, value, onChange }: { options: readonly CapabilityScopeOption[]; value: CapabilityScopeKey; onChange: (key: CapabilityScopeKey) => void }) {
  return (
    <RadioGroup.Root aria-label="Agent" orientation="horizontal" value={value} onValueChange={(v) => onChange(v as CapabilityScopeKey)} className="flex flex-wrap gap-2">
      {options.map((option) => (
        <RadioGroup.Item
          key={option.key}
          value={option.key}
          title={option.label}
          className="flex h-9 max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full border border-border pr-3 pl-2 text-minor font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:border-transparent data-[state=checked]:bg-sidebar-active data-[state=checked]:text-foreground"
        >
          {option.look === null ? <RouterAvatar size={20} /> : <Avatar look={option.look} size={20} />}
          <span className="truncate">{option.label}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

function CapabilityItemRow({ row, onApply }: { row: CapabilityRow; onApply: ApplyPatches }) {
  const id = useId();
  return (
    <div className="flex min-h-12 items-center gap-4 py-2.5 pr-4 pl-10">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} title={row.key} className="block cursor-pointer truncate text-body">
          {row.name}
        </label>
        {row.description && (
          <p title={row.description} className="truncate text-minor leading-snug text-muted-foreground">
            {row.description}
          </p>
        )}
      </div>
      <Switch id={id} checked={row.enabled} onCheckedChange={(on) => onApply([{ set: { [row.key]: on } }])} />
    </div>
  );
}

function SourceGroupRow({ group, expanded, onApply }: { group: CapabilitySourceGroup; expanded: boolean; onApply: ApplyPatches }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open || expanded} onOpenChange={setOpen}>
      <div className="flex min-h-13 items-center gap-3 pr-4 transition-colors hover:bg-sidebar-hover">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch py-2 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset">
          <ChevronRight className="size-pixel-sm shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body">{group.label}</span>
            {group.detail && <span className="block truncate text-minor leading-snug text-muted-foreground">{group.detail}</span>}
          </span>
          <span className="shrink-0 text-minor text-muted-foreground tabular-nums">{countLabel(group.enabled, group.rows.length)}</span>
        </CollapsibleTrigger>
        <Switch
          aria-label={group.detail === null ? group.label : `${group.label} ${group.detail}`}
          checked={group.enabled === group.rows.length}
          onCheckedChange={(on) => onApply(rowsPatches(group.rows, on))}
        />
      </div>
      <CollapsibleContent className="divide-y divide-border border-t border-border">
        {group.rows.map((row) => (
          <CapabilityItemRow key={row.key} row={row} onApply={onApply} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function KindSection({
  section,
  searching,
  onToggleAll,
  onApply,
}: {
  section: CapabilityKindSection;
  searching: boolean;
  onToggleAll: (on: boolean) => void;
  onApply: ApplyPatches;
}) {
  const bulk = !searching && section.total > 0;
  return (
    <SettingsGroup
      title={CAPABILITY_KIND_LABELS[section.kind]}
      action={
        <span className={cn("ml-auto flex items-center gap-1", bulk && "-mr-3")}>
          <span className="text-minor text-muted-foreground tabular-nums">{countLabel(section.enabled, section.total)}</span>
          {bulk && (
            <Button variant="ghost" size="sm" onClick={() => onToggleAll(section.enabled === 0)}>
              {section.enabled === 0 ? "Turn all on" : "Turn all off"}
            </Button>
          )}
        </span>
      }
    >
      {section.groups.length === 0 ? (
        <p className="px-4 py-3 text-body text-muted-foreground">{EMPTY_LABELS[section.kind]}</p>
      ) : (
        section.groups.map((group) => <SourceGroupRow key={group.id} group={group} expanded={searching} onApply={onApply} />)
      )}
    </SettingsGroup>
  );
}

function IsolationCell({ cell }: { cell: EnforcementCell }) {
  return (
    <td className="px-2 py-2.5 align-baseline text-minor whitespace-nowrap">
      <span aria-hidden="true" className={cn("mr-2 inline-block size-2 rounded-full", ISOLATION_DOTS[cell.isolation])} />
      {ISOLATION_LABELS[cell.isolation]}
      {cell.plugin !== null && <span className="block pl-4 text-xs text-muted-foreground">Plugins: {ISOLATION_LABELS[cell.plugin].toLowerCase()}</span>}
    </td>
  );
}

function EnforcementGroup({ view }: { view: CapabilitiesView }) {
  return (
    <CollapsibleGroup title="Enforcement by provider">
      <div className="overflow-x-auto">
        <table aria-label="Enforcement by provider" className="w-full text-left">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="px-4 py-2 font-medium">
                <span className="sr-only">Provider</span>
              </th>
              {CAPABILITY_KIND_ORDER.map((kind) => (
                <th key={kind} scope="col" className="px-2 py-2 font-medium">
                  {COLUMN_LABELS[kind]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {enforcementRows(view).map((row) => (
              <tr key={row.vendor}>
                <th scope="row" className="px-4 py-2.5 align-baseline text-body font-normal">
                  {row.label}
                </th>
                {CAPABILITY_KIND_ORDER.map((kind) => (
                  <IsolationCell key={kind} cell={row.cells[kind]} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CollapsibleGroup>
  );
}

function ScopePanel({ option }: { option: CapabilityScopeOption }) {
  const { data: view, error, isPending, refetch } = useCapabilitiesView(option.scope);
  const editor = useCapabilityEditor(option.scope);
  const [query, setQuery] = useState("");
  if (view === undefined) {
    return isPending ? (
      <div className="flex min-h-14 items-center justify-center gap-2 text-minor text-muted-foreground">
        <Loader2 className="size-pixel" aria-hidden="true" />
        Loading…
      </div>
    ) : (
      <div className="flex items-center gap-3 px-4">
        <RowError error={errorText(error)} />
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const searching = query.trim() !== "";
  const sections = filterCapabilitySections(capabilitySections(view.inventory, view.policy), query);
  return (
    <>
      <EnforcementGroup view={view} />
      <div className="flex items-center gap-2">
        <SearchField label="Search capabilities" value={query} onChange={setQuery} />
        <Button variant="ghost" size="sm" className="-mr-3" disabled={editor.refreshing} onClick={() => void editor.refresh()}>
          {editor.refreshing && <Loader2 aria-hidden="true" />}
          Refresh
        </Button>
      </div>
      {editor.error && (
        <div className="px-4">
          <RowError error={editor.error} />
        </div>
      )}
      {sections.length === 0 && <p className="px-4 text-body text-muted-foreground">No matches</p>}
      {sections.map((section) => (
        <KindSection
          key={section.kind}
          section={section}
          searching={searching}
          onToggleAll={(on) => editor.apply(kindPatches(view.policy, section.kind, on))}
          onApply={editor.apply}
        />
      ))}
    </>
  );
}

export function CapabilitiesSettings() {
  const { options, requested, request } = useContext(CapabilityScopesContext);
  const [selected, setSelected] = useState(requested);
  const option = options.find((o) => o.key === selected) ?? ROUTER_SCOPE_OPTION;
  const select = (key: CapabilityScopeKey) => {
    setSelected(key);
    request(key);
  };
  return (
    <>
      <ScopeStrip options={options} value={option.key} onChange={select} />
      <ScopePanel key={option.key} option={option} />
    </>
  );
}

export function CapabilitiesEntry({ pmId, onOpen }: { pmId: PmId; onOpen: () => void }) {
  const { request } = useContext(CapabilityScopesContext);
  const { data: view } = useCapabilitiesView({ kind: "pm", pmId });
  const totals = view === undefined ? null : capabilityTotals(capabilitySections(view.inventory, view.policy));
  return (
    <SettingsGroup title="Capabilities">
      <SettingsNavRow
        label="MCP servers, skills, and connectors"
        {...(totals !== null && totals.total > 0 ? { summary: countLabel(totals.enabled, totals.total) } : {})}
        onClick={() => {
          request(`pm:${pmId}`);
          onOpen();
        }}
      />
    </SettingsGroup>
  );
}
