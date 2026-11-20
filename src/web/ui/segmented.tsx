import * as RadioGroup from "@radix-ui/react-radio-group";
import { cn } from "../lib/utils.ts";

export function Segmented<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  className,
}: {
  id?: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <RadioGroup.Root
      id={id}
      aria-label={label}
      orientation="horizontal"
      value={value}
      onValueChange={(v) => onChange(v as T)}
      className={cn("inline-flex h-9 items-center gap-0.5 rounded-full border border-border bg-background p-0.5", className)}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className="h-full cursor-pointer rounded-full px-3 text-minor font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=checked]:bg-sidebar-active data-[state=checked]:text-foreground"
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
