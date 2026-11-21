import type { QuotaVendor } from "../selectors.ts";
import { useResourcesAttention } from "../resources-model.ts";
import { Button } from "../ui/button.tsx";
import { Download, Plus, Settings } from "../ui/icons.ts";
import { useUpdateReminder } from "../update-model.ts";
import { QuotaPopover } from "./QuotaPopover.tsx";

export function SidebarTools({
  narrow,
  quota,
  quotaFetchable,
  onNewPm,
  onOpenSettings,
  onOpenUpdates,
}: {
  narrow: boolean;
  quota: QuotaVendor[] | undefined;
  quotaFetchable: boolean;
  onNewPm: () => void;
  onOpenSettings: () => void;
  onOpenUpdates: () => void;
}) {
  const reminder = useUpdateReminder();
  const resources = useResourcesAttention();
  const updateLabel = reminder === null ? "" : `Update to v${reminder.latestVersion}`;
  const update = reminder && (
    <Button variant="slot" size={narrow ? "icon" : "default"} aria-label={updateLabel} title={updateLabel} className={narrow ? undefined : "ml-auto"} onClick={onOpenUpdates}>
      <Download aria-hidden="true" />
      {!narrow && <span className="text-foreground">Update</span>}
    </Button>
  );
  const usage = quota && <QuotaPopover quota={quota} fetchable={quotaFetchable} />;
  const settings = (
    <Button
      variant="slot"
      size="icon"
      className={narrow || update ? "relative" : "relative ml-auto"}
      aria-label={resources.attention ? `Settings (${resources.heldCount} held)` : "Settings"}
      onClick={onOpenSettings}
    >
      <Settings aria-hidden="true" />
      {resources.attention && (
        <span
          data-testid="settings-resources-attention"
          aria-hidden="true"
          className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-caution ring-2 ring-surface-sidebar"
        />
      )}
    </Button>
  );
  if (narrow) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 py-3">
        <Button variant="slot" size="icon" aria-label="New project manager" onClick={onNewPm}>
          <Plus aria-hidden="true" />
        </Button>
        {usage}
        {update}
        {settings}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-3 py-3">
      {usage}
      {update}
      {settings}
    </div>
  );
}
