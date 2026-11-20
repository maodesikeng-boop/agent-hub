import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

export const buttonVariants = cva(
  "touch-target inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-pixel",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:brightness-90 disabled:bg-sidebar-active disabled:text-muted-foreground disabled:opacity-100",
        destructive: "bg-danger text-primary-foreground hover:brightness-90 disabled:bg-sidebar-active disabled:text-muted-foreground disabled:opacity-100",
        outline: "border border-border bg-background hover:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        slot: "tool-slot text-muted-foreground hover:text-foreground",
      },
      size: {
        default: "h-9 rounded-[var(--radius-btn)] px-4 text-minor",
        sm: "h-8 rounded-[var(--radius-btn)] px-3 text-minor",
        icon: "size-9 rounded-[var(--radius-btn)]",
        "icon-sm": "size-8 rounded-[var(--radius-btn)]",
      },
    },
    compoundVariants: [
      { variant: "ghost", size: ["default", "sm"], class: "text-foreground" },
      { variant: "slot", class: "rounded-[4px] [&_svg:not([class*='size-'])]:size-pixel-md" },
      { variant: "slot", size: "default", class: "h-7.5 px-3" },
      { variant: "slot", size: "icon", class: "size-7.5" },
      { variant: "slot", size: "icon-sm", class: "size-6 [&_svg:not([class*='size-'])]:size-pixel-sm" },
    ],
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
