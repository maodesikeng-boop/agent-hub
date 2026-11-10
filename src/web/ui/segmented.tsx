// 分段选择（docs/ui-standard.md 第 9 条）：几个短选项排成一行的多选一，用 Radix RadioGroup（方向键切换、读屏是单选组）。
// 白底细框的胶囊，选中的那段浅灰底 + 前景色字，不用强调色。
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
  /** 读屏名字。 */
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
