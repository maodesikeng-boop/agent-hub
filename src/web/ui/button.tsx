import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

export const buttonVariants = cva(
  "touch-target inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-pixel",
  {
    variants: {
      variant: {
        default:
          "border-2 border-black/25 bg-primary text-primary-foreground shadow-[inset_0_-2px_0_rgb(0_0_0_/_0.22)] hover:brightness-90 active:translate-y-px disabled:border-border-strong disabled:bg-send-disabled disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100",
        destructive:
          "border-2 border-black/25 bg-danger text-primary-foreground shadow-[inset_0_-2px_0_rgb(0_0_0_/_0.22)] hover:brightness-90 active:translate-y-px disabled:border-border-strong disabled:bg-send-disabled disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100",
        outline: "border-2 border-border-strong bg-background text-foreground hover:bg-hover",
        secondary: "border-2 border-border-strong bg-panel text-foreground hover:bg-hover",
        ghost: "text-muted-foreground hover:bg-hover hover:text-foreground",
        slot: "tool-slot text-muted-foreground hover:text-foreground",
      },
      size: {
        default: "h-9 px-4 text-minor",
        sm: "h-8 px-3 text-minor",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    compoundVariants: [
      { variant: "ghost", size: ["default", "sm"], class: "text-foreground" },
      { variant: "slot", class: "[&_svg:not([class*='size-'])]:size-pixel-md" },
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
