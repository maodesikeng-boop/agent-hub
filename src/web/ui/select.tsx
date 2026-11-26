import * as SelectPrimitive from "@radix-ui/react-select";
import type * as React from "react";
import { cn } from "../lib/utils.ts";
import { Check, ChevronDown, ChevronUp } from "./icons.ts";

// Radix Select treats value="" as cleared/placeholder, so map empty option values transparently.
const EMPTY_VALUE = "__bellwood_empty_select__";
const encodeValue = (v: string | undefined) => (v === "" ? EMPTY_VALUE : v);
const decodeValue = (v: string) => (v === EMPTY_VALUE ? "" : v);

export function Select({
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return (
    <SelectPrimitive.Root
      data-slot="select"
      {...(value !== undefined ? { value: encodeValue(value) } : {})}
      {...(defaultValue !== undefined ? { defaultValue: encodeValue(defaultValue) } : {})}
      {...(onValueChange !== undefined ? { onValueChange: (next) => onValueChange(decodeValue(next)) } : {})}
      {...props}
    />
  );
}

export function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

export function SelectTrigger({
  className,
  variant = "field",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { variant?: "field" | "plain" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      className={cn(
        "touch-target inline-flex h-9 min-w-0 cursor-pointer items-center justify-between gap-2 text-body text-foreground transition-colors disabled:cursor-default disabled:opacity-50 pointer-coarse:h-11 *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "plain"
          ? "info-select -mr-2 h-7.5 w-auto max-w-56 gap-1 border-0 bg-transparent px-2 text-minor tabular-nums"
          : "w-full border border-border-strong bg-background px-3 outline-none hover:border-[rgb(110_74_0_/_0.36)] focus-visible:field-focus data-[state=open]:field-focus aria-invalid:border-danger",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className={variant === "plain" ? "info-chevron size-3.5" : "size-4 text-muted-foreground"} aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1 text-muted-foreground", className)}
      {...props}
    >
      <ChevronUp className="size-3.5" aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  );
}

export function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1 text-muted-foreground", className)}
      {...props}
    >
      <ChevronDown className="size-3.5" aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 4,
  collisionPadding = 12,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "pointer-events-auto relative z-50 max-h-(--radix-select-content-available-height) min-w-[var(--radix-select-trigger-width)] max-w-[min(22.5rem,var(--radix-select-available-width))] overflow-x-hidden overflow-y-auto rounded-sm border border-border bg-background text-foreground shadow-[var(--shadow-overlay)] outline-none",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function SelectItem({ className, children, value, detail, ...props }: React.ComponentProps<typeof SelectPrimitive.Item> & { detail?: React.ReactNode }) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={encodeValue(value) ?? ""}
      className={cn(
        "relative flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-xs py-1 pr-8 pl-2.5 text-minor outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover data-[state=checked]:bg-open pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    >
      <span data-slot="select-item-indicator" className="absolute right-2.5 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-brand-ink" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {detail === undefined ? (
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      ) : (
        <span className="flex min-w-0 flex-col">
          <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
          <span className="text-xs leading-snug text-muted-foreground">{detail}</span>
        </span>
      )}
    </SelectPrimitive.Item>
  );
}
