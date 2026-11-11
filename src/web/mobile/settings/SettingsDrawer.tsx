// 手机设置的底部抽屉（docs/ui-standard.md 第 10 条“抽屉”）：承载短表单向导（改名、连到中心、邀请、添加）与危险操作二次确认。
// 底层是 ui/drawer.tsx（vaul），调用方不直接 import vaul；按钮全宽 44px（h-11），危险确认是红色 destructive + outline Cancel。
import { Loader2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { ErrorLike } from "../../format.ts";
import { RowError } from "../../components/SettingsList.tsx";
import { Button } from "../../ui/button.tsx";
import { Drawer, DrawerContent, DrawerTitle } from "../../ui/drawer.tsx";

/** 抽屉里的按钮：全宽、44px 高。 */
export const DRAWER_BUTTON = "h-11 w-full";

export function SettingsDrawer({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
      <DrawerContent>
        <DrawerTitle className="shrink-0 truncate px-4 pt-1 pb-3 text-center text-title font-semibold">{title}</DrawerTitle>
        <div className="grid min-h-0 grid-cols-1 gap-4 overflow-x-hidden overflow-y-auto overscroll-y-contain px-4 pb-4">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}

/** 危险操作的确认（标题 + 一句后果 + 红色确认 + Cancel）。 */
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
      <p className="text-center text-body leading-snug text-muted-foreground">{description}</p>
      {error && <RowError error={error} />}
      <div className="grid grid-cols-1 gap-2">
        <Button variant="destructive" className={DRAWER_BUTTON} disabled={busy} onClick={onConfirm}>
          {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
          {confirmLabel}
        </Button>
        <Button variant="outline" className={DRAWER_BUTTON} disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}

/** 抽屉的目标：关的时候留着上一个目标，收起动画里内容不变空。 */
export function useDrawerTarget<T>() {
  const [state, setState] = useState<{ target: T | null; open: boolean }>({ target: null, open: false });
  const show = useCallback((target: T) => setState({ target, open: true }), []);
  const onOpenChange = useCallback((open: boolean) => setState((s) => (s.open === open ? s : { ...s, open })), []);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return { target: state.target, open: state.open, show, close, onOpenChange };
}
