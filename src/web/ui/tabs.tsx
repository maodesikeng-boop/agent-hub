import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";

export const Tabs = TabsPrimitive.Root;
export const TabsList = TabsPrimitive.List;
export const TabsContent = TabsPrimitive.Content;

export function TabsTrigger({ onMouseDown, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      {...props}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        // Radix focuses the tab from script on mouse down, which browsers mark as keyboard focus right after typing.
        if (!event.defaultPrevented && props.disabled !== true && event.button === 0 && !event.ctrlKey) {
          event.currentTarget.focus({ focusVisible: false });
        }
      }}
    />
  );
}
