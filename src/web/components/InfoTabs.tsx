import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { cn } from "../lib/utils.ts";

/**
 * Underline tabs for a choice that changes what the page shows below it. `children` is the selected option's content and
 * renders inside the tab panel the selected tab controls; `aside` sits on the tab row and wraps below it when the row is full.
 */
export function InfoTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  aside,
  className,
  children,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  aside?: ReactNode;
  /** Layout of the tabs root and of the panel, such as the gap the surrounding grid used. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} activationMode="manual" className={cn("grid min-w-0 grid-cols-1", className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <TabsList aria-label={label} className="info-tabs min-w-0 flex-auto">
          {options.map((o) => (
            <TabsTrigger key={o.value} value={o.value} title={o.label} className="info-tab touch-target min-w-0">
              <span className="truncate">{o.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {aside}
      </div>
      {options.map((o) => (
        // The panel holds its own controls, so it stays out of the Tab order.
        <TabsContent key={o.value} value={o.value} tabIndex={-1} className={cn("grid min-w-0 grid-cols-1 outline-none", className)}>
          {children}
        </TabsContent>
      ))}
    </Tabs>
  );
}
