import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { PM_FRUITS } from "../../shared/fruits.ts";
import { JELLY_COLOR_IDS, jellyColorOf, SLIME_SHAPE_LABELS, slimeLookOf, type SlimeLook } from "../../shared/slimes.ts";
import { errorLine, errorTitle, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Avatar } from "./Avatar.tsx";

const FRUIT_COLUMNS = 5;
const COLOR_COLUMNS = 8;

function moveFocus(e: KeyboardEvent<HTMLDivElement>, columns: number) {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
  let next: number | null = null;
  if (e.key in step) next = Math.min(items.length - 1, Math.max(0, index + step[e.key]!));
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = items.length - 1;
  if (next === null) return;
  e.preventDefault();
  items[next]!.focus();
}

export function SlimePicker({
  look,
  onChange,
  error,
  children,
}: {
  look: SlimeLook;
  onChange: (next: SlimeLook) => void;
  error?: ErrorLike | null;
  children: ReactElement;
}): ReactNode {
  const fruitsRef = useRef<HTMLDivElement>(null);
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        aria-label="Change look"
        className="flex flex-col gap-4"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          fruitsRef.current?.querySelector<HTMLButtonElement>("[aria-checked=true]")?.focus();
        }}
      >
        <section className="flex flex-col gap-2">
          <h3 id="slime-picker-fruit" className="text-xs font-medium text-muted-foreground">
            Fruit
          </h3>
          <div
            ref={fruitsRef}
            role="radiogroup"
            aria-labelledby="slime-picker-fruit"
            className="grid grid-cols-5 gap-1"
            onKeyDown={(e) => moveFocus(e, FRUIT_COLUMNS)}
          >
            {PM_FRUITS.map((fruit) => {
              const checked = fruit === look.fruit;
              const candidate = slimeLookOf(fruit, look.color);
              return (
                <button
                  key={fruit}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={SLIME_SHAPE_LABELS[fruit]}
                  title={SLIME_SHAPE_LABELS[fruit]}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => onChange(candidate)}
                  className={cn(
                    "flex size-12 cursor-pointer items-center justify-center rounded-sm transition-[background-color,box-shadow] duration-150 outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] motion-reduce:transition-none",
                    checked ? "tile-open" : "hover:bg-hover",
                  )}
                >
                  <Avatar look={candidate} size={34} />
                </button>
              );
            })}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h3 id="slime-picker-color" className="text-xs font-medium text-muted-foreground">
            Color
          </h3>
          <div role="radiogroup" aria-labelledby="slime-picker-color" className="grid grid-cols-8 gap-1" onKeyDown={(e) => moveFocus(e, COLOR_COLUMNS)}>
            {JELLY_COLOR_IDS.map((id) => {
              const checked = id === look.color;
              const color = jellyColorOf(id);
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={color.label}
                  title={color.label}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => onChange(slimeLookOf(look.fruit, id))}
                  className={cn(
                    "flex size-8 cursor-pointer items-center justify-center rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]",
                    checked ? "tile-open" : "hover:bg-hover",
                  )}
                >
                  <span aria-hidden="true" style={{ backgroundColor: color.blob }} className="size-6 rounded-xs shadow-[inset_0_0_0_1px_rgb(0_0_0_/_0.12)]" />
                </button>
              );
            })}
          </div>
        </section>
        {error != null && (
          <p role="alert" title={errorTitle(error)} className="text-minor text-danger">
            {errorLine(error)}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
