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
      className={cn("inline-flex h-9 items-center gap-0.5 rounded-sm border border-border bg-panel p-0.5", className)}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          className="touch-target h-full cursor-pointer rounded-xs px-3 text-minor font-medium text-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] motion-reduce:transition-none data-[state=checked]:tile-selected data-[state=checked]:text-foreground"
        >
          {o.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
