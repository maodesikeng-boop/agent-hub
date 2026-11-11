import { memo, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { RailGroups } from "../components/RightRail.tsx";
import { Drawer, DrawerContent, DrawerTitle } from "../ui/drawer.tsx";

// memo：App 每个流式帧都会重画，抽屉的 props（右栏数据、回调）都是稳定引用，开着时不跟着重画
export const PiecesDrawer = memo(function PiecesDrawer({ open, onOpenChange, onOpenAsk, onOpenWorker, ...groups }: ComponentProps<typeof RailGroups> & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const close = () => flushSync(() => onOpenChange(false));
  return <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
    <DrawerContent onCloseAutoFocus={(e) => e.preventDefault()}>
      <DrawerTitle className="sr-only">Pieces</DrawerTitle>
      <RailGroups {...groups} onOpenAsk={(id) => { close(); onOpenAsk(id); }} onOpenWorker={(id) => { close(); onOpenWorker(id); }} />
    </DrawerContent>
  </Drawer>;
});
