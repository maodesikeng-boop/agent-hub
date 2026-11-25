import { useId, useState, type ReactNode } from "react";
import { vendorLabel, type AgentVendor, type CapabilitiesPatch, type CapabilityScope } from "../../shared/index.ts";
import {
  CAPABILITY_KIND_TAGS,
  capabilityCustomized,
  capabilitySections,
  capabilityTotals,
  filterCapabilitySections,
  rowsPatches,
  useCapabilitiesView,
  useCapabilityEditor,
  type CapabilityRow,
  type CapabilitySection,
  type CapabilityUnit,
} from "../capabilities-model.ts";
import { errorText } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { SettingsNavRow } from "../mobile/settings/SettingsNavRow.tsx";
import { Button } from "../ui/button.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.tsx";
import { ChevronRight, Loader2 } from "../ui/icons.ts";
import { Switch } from "../ui/switch.tsx";
import { SearchField } from "./SearchField.tsx";
import { CollapsibleGroup, RowError, SettingsGroup } from "./SettingsList.tsx";

type ApplyPatches = (patches: readonly CapabilitiesPatch[]) => void;

export const countLabel = (enabled: number, total: number) => `${enabled} of ${total}`;

const audienceLabel = (vendors: readonly AgentVendor[]) => vendors.map(vendorLabel).join(", ");

export function CustomBadge() {
  return <span className="tool-badge shrink-0 px-2 py-0.5 text-xs font-medium">Custom</span>;
}

function KindTag({ kind }: { kind: CapabilityRow["kind"] }) {
  return <span className="shrink-0 rounded-xs bg-panel px-2 text-xs leading-5 font-medium text-muted-foreground">{CAPABILITY_KIND_TAGS[kind]}</span>;
}

function Audience({ vendors }: { vendors: readonly AgentVendor[] | null }) {
  if (vendors === null) return null;
  const text = audienceLabel(vendors);
  return (
    <span title={text} className="max-w-full min-w-0 truncate text-minor text-muted-foreground">
      {text}
    </span>
  );
}

// Tags wrap under the name on narrow rows so the name itself never truncates early.
function Labels({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">{children}</span>;
}

function ItemRow({ row, nested, disabled, onApply }: { row: CapabilityRow; nested: boolean; disabled: boolean; onApply: ApplyPatches }) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-3 py-2 pr-4 pl-10", nested ? "min-h-11" : "min-h-12")}>
      <Labels>
        <label htmlFor={id} title={row.description ?? row.key} className={cn("max-w-full min-w-0 truncate text-body", disabled ? "cursor-default" : "cursor-pointer")}>
          {row.name}
        </label>
        <KindTag kind={row.kind} />
        <Audience vendors={row.audience} />
        {row.pinned && <CustomBadge />}
      </Labels>
      <Switch id={id} checked={row.enabled} disabled={disabled} onCheckedChange={(on) => onApply([{ set: { [row.key]: on } }])} />
    </div>
  );
}

function UnitRow({ unit, expanded, disabled, onApply }: { unit: CapabilityUnit; expanded: boolean; disabled: boolean; onApply: ApplyPatches }) {
  const [open, setOpen] = useState(false);
  if (unit.single) return <ItemRow row={{ ...unit.rows[0]!, audience: unit.audience }} nested={false} disabled={disabled} onApply={onApply} />;
  return (
    <Collapsible open={open || expanded} onOpenChange={setOpen}>
      <div className="flex min-h-12 items-center gap-3 pr-4 transition-colors hover:bg-hover">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch py-2 pl-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]">
          <ChevronRight className="size-pixel-sm shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
          <Labels>
            <span title={unit.label} className="max-w-full min-w-0 truncate text-body">
              {unit.label}
            </span>
            <Audience vendors={unit.audience} />
            {unit.pinned > 0 && <CustomBadge />}
          </Labels>
          <span className="shrink-0 text-minor text-muted-foreground tabular-nums">{countLabel(unit.enabled, unit.rows.length)}</span>
        </CollapsibleTrigger>
        <Switch aria-label={unit.label} checked={unit.enabled === unit.rows.length} disabled={disabled} onCheckedChange={(on) => onApply(rowsPatches(unit.rows, on))} />
      </div>
      <CollapsibleContent className="divide-y divide-border border-t border-border">
        {unit.rows.map((row) => (
          <ItemRow key={row.key} row={row} nested disabled={disabled} onApply={onApply} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SectionGroup({ section, searching, disabled, onApply }: { section: CapabilitySection; searching: boolean; disabled: boolean; onApply: ApplyPatches }) {
  const units = section.units.map((unit) => <UnitRow key={unit.id} unit={unit} expanded={searching} disabled={disabled} onApply={onApply} />);
  const count = countLabel(section.enabled, section.total);
  if (section.secondary && !searching) {
    return (
      <CollapsibleGroup title={section.label} summary={count}>
        {units}
      </CollapsibleGroup>
    );
  }
  // A lone unit row already shows the same count.
  const action = section.units.length > 1 ? <span className="text-minor text-muted-foreground tabular-nums">{count}</span> : undefined;
  return (
    <SettingsGroup title={section.label} action={action}>
      {units}
    </SettingsGroup>
  );
}

function InheritanceGroup({
  pinned,
  customized,
  disabled,
  onEditDefaults,
  onReset,
}: {
  pinned: number;
  customized: boolean;
  disabled: boolean;
  onEditDefaults: () => void;
  onReset: () => void;
}) {
  const summary = pinned > 0 ? `${pinned} custom` : customized ? "Custom" : "Inherited";
  return (
    <SettingsGroup label="Inheritance">
      <SettingsNavRow label="Project defaults" summary={summary} onClick={onEditDefaults} />
      {customized && <SettingsNavRow label="Reset to Project defaults" chevron={false} disabled={disabled} onClick={onReset} />}
    </SettingsGroup>
  );
}

function PanelStatus({ pending, error, onRetry }: { pending: boolean; error: unknown; onRetry: () => void }) {
  if (pending) {
    return (
      <div className="flex min-h-14 items-center justify-center gap-2 text-minor text-muted-foreground">
        <Loader2 className="size-pixel" aria-hidden="true" />
        Loading…
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 px-4">
      <RowError error={errorText(error)} />
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

export function CapabilitiesPanel({
  scope,
  lead = null,
  disabled = false,
  onEditDefaults,
}: {
  scope: CapabilityScope;
  lead?: AgentVendor | null;
  disabled?: boolean;
  onEditDefaults?: () => void;
}) {
  const { data: view, error, isPending, refetch } = useCapabilitiesView(scope);
  const editor = useCapabilityEditor(scope);
  const [query, setQuery] = useState("");
  if (view === undefined) return <PanelStatus pending={isPending} error={error} onRetry={() => void refetch()} />;
  const searching = query.trim() !== "";
  const all = capabilitySections(view, lead);
  const sections = filterCapabilitySections(all, query);
  return (
    <>
      {view.inheritance !== null && onEditDefaults !== undefined && (
        <InheritanceGroup
          pinned={capabilityTotals(all).pinned}
          customized={capabilityCustomized(view)}
          disabled={disabled}
          onEditDefaults={onEditDefaults}
          onReset={editor.reset}
        />
      )}
      <div className="flex items-center gap-2">
        {/* The icon starts on the 16px edge where the rows below start their text. */}
        <SearchField label="Search capabilities" value={query} onChange={setQuery} className="pl-4" />
        <Button variant="outline" disabled={disabled || editor.refreshing} onClick={() => void editor.refresh()}>
          {editor.refreshing && <Loader2 aria-hidden="true" />}
          Refresh
        </Button>
      </div>
      {editor.error && (
        <div className="px-4">
          <RowError error={editor.error} />
        </div>
      )}
      {sections.length === 0 && <p className="px-4 text-body text-muted-foreground">{searching ? "No matches" : "No capabilities found"}</p>}
      {sections.map((section) => (
        <SectionGroup key={section.id} section={section} searching={searching} disabled={disabled} onApply={editor.apply} />
      ))}
    </>
  );
}
