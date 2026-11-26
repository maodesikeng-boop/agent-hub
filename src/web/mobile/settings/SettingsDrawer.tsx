import { Loader2 } from "../../ui/icons.ts";
import { useCallback, useState, type ComponentProps, type ReactNode } from "react";
import type { ErrorLike } from "../../format.ts";
import { RowError } from "../../components/SettingsList.tsx";
import { Button } from "../../ui/button.tsx";
import { Drawer, DrawerContent, DrawerTitle } from "../../ui/drawer.tsx";

export const DRAWER_BUTTON = "h-11 w-full";

export function SettingsDrawer({
  open,
  onOpenChange,
  title,
  children,
  onPointerDownOutside,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  onPointerDownOutside?: ComponentProps<typeof DrawerContent>["onPointerDownOutside"];
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      <DrawerContent onPointerDownOutside={onPointerDownOutside}>
        <DrawerTitle className="shrink-0 truncate px-4 pt-1 pb-3 text-center text-title font-semibold">{title}</DrawerTitle>
        <div className="grid min-h-0 grid-cols-1 gap-4 overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 pb-4">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

export function ConfirmBody({
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  description: ReactNode;
  confirmLabel: string;
  busy: boolean;
  error?: ErrorLike | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="text-center text-minor leading-snug text-muted-foreground">{description}</p>
      {error && <RowError error={error} />}
      <div className="grid grid-cols-1 gap-2">
        <Button variant="destructive" className={DRAWER_BUTTON} disabled={busy} onClick={onConfirm}>
          {busy && <Loader2 aria-hidden="true" />}
          {confirmLabel}
        </Button>
        <Button variant="outline" className={DRAWER_BUTTON} disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

export function useDrawerTarget<T>() {
  const [state, setState] = useState<{ target: T | null; open: boolean }>({ target: null, open: false });
  const show = useCallback((target: T) => setState({ target, open: true }), []);
  const onOpenChange = useCallback((open: boolean) => setState((s) => (s.open === open ? s : { ...s, open })), []);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return { target: state.target, open: state.open, show, close, onOpenChange };
}
