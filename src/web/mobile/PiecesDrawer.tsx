import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { RailGroups } from "../components/RightRail.tsx";
import { Drawer, DrawerContent, DrawerTitle } from "../ui/drawer.tsx";

export function PiecesDrawer({ open, onOpenChange, onOpenAsk, onOpenWorker, ...groups }: ComponentProps<typeof RailGroups> & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const close = () => flushSync(() => onOpenChange(false));
  return <Drawer open={open} onOpenChange={onOpenChange} shouldScaleBackground={false}>
    <DrawerContent onCloseAutoFocus={(e) => e.preventDefault()}>
      <DrawerTitle className="sr-only">Pieces</DrawerTitle>
      <RailGroups {...groups} onOpenAsk={(id) => { close(); onOpenAsk(id); }} onOpenWorker={(id) => { close(); onOpenWorker(id); }} />
    </DrawerContent>
  </Drawer>;
}
