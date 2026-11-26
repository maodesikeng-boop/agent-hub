import type { ComponentProps, ReactNode } from "react";
import { SettingsDrawer } from "../mobile/settings/SettingsDrawer.tsx";
import { Surface, SurfaceOutlet, SurfaceScope } from "../shell-surfaces.tsx";
import { Dialog, DialogContent } from "../ui/dialog.tsx";

export function ProviderSheetChrome({ mobile, title, onClose, children }: {
  mobile: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const body = <SurfaceOutlet id="settings:provider-sheet" className="contents provider-sheet-outlet" />;
  const keepSheetOpen: ComponentProps<typeof DialogContent>["onPointerDownOutside"] = (event) => {
    const target = event.detail.originalEvent.target;
    if (target instanceof Element && target.closest(".provider-sheet-outlet")) event.preventDefault();
  };
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  return (
    <SurfaceScope>
      {mobile ? (
        <SettingsDrawer open onOpenChange={onOpenChange} title={title} onPointerDownOutside={keepSheetOpen}>{body}</SettingsDrawer>
      ) : (
        <Dialog open onOpenChange={onOpenChange}>
          <DialogContent title={title} className="max-w-110" onPointerDownOutside={keepSheetOpen}>{body}</DialogContent>
        </Dialog>
      )}
      <Surface id="settings:provider-sheet">{children}</Surface>
    </SurfaceScope>
  );
}
