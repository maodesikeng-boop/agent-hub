import { Tabs, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { cn } from "../lib/utils.ts";

/** Underline tabs for a choice that changes what the page shows below it. */
export function InfoTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as T)} activationMode="manual">
      <TabsList aria-label={label} className={cn("info-tabs", className)}>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value} title={o.label} className="info-tab touch-target min-w-0">
            <span className="truncate">{o.label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
