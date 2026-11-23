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
        "touch-target inline-flex h-9 min-w-0 cursor-pointer items-center justify-between gap-2 text-body text-foreground transition-colors outline-none disabled:cursor-default disabled:opacity-50 pointer-coarse:h-11 *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate [&_svg]:pointer-events-none [&_svg]:shrink-0",
        variant === "plain"
          ? "-mr-3 w-auto max-w-65 border-2 border-transparent bg-transparent pr-2.5 pl-3 hover:bg-hover focus-visible:border-border-focus focus-visible:bg-hover data-[state=open]:bg-hover"
          : "w-full border-2 border-border-strong bg-background px-3 hover:bg-hover focus:border-border-focus focus-visible:border-border-focus data-[state=open]:border-border-focus aria-invalid:border-danger",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className={cn("text-muted-foreground", variant === "plain" ? "size-3.5" : "size-4")} aria-hidden="true" />
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
          "pointer-events-auto relative z-50 max-h-(--radix-select-content-available-height) min-w-[var(--radix-select-trigger-width)] max-w-[min(22.5rem,var(--radix-select-available-width))] overflow-x-hidden overflow-y-auto border-2 border-border-strong bg-background text-foreground outline-none",
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
      className={cn("-mx-1 my-1 h-0.5 bg-border", className)}
      {...props}
    />
  );
}

export function SelectItem({ className, children, value, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      value={encodeValue(value) ?? ""}
      className={cn(
        "relative flex min-h-8 w-full cursor-pointer items-center gap-2 py-1.5 pr-8 pl-2.5 text-body outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-hover data-[state=checked]:bg-open pointer-coarse:min-h-11",
        className,
      )}
      {...props}
    >
      <span data-slot="select-item-indicator" className="absolute right-2.5 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-3.5 text-rail-ink" aria-hidden="true" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}
