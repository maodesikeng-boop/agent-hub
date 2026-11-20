import type { QuotaVendor } from "../selectors.ts";
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
  const updateLabel = reminder === null ? "" : `Update to v${reminder.latestVersion}`;
  const update = reminder && (
    <Button variant="slot" size={narrow ? "icon" : "default"} aria-label={updateLabel} title={updateLabel} className={narrow ? undefined : "ml-auto"} onClick={onOpenUpdates}>
      <Download aria-hidden="true" />
      {!narrow && <span className="text-foreground">Update</span>}
    </Button>
  );
  const usage = quota && <QuotaPopover quota={quota} fetchable={quotaFetchable} />;
  const settings = (
    <Button variant="slot" size="icon" className={narrow || update ? undefined : "ml-auto"} aria-label="Settings" onClick={onOpenSettings}>
      <Settings aria-hidden="true" />
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
