import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

export const buttonVariants = cva(
  "touch-target inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-sm whitespace-nowrap font-medium transition-colors focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-pixel",
  {
    variants: {
      variant: {
        default:
          "btn-solid bg-primary text-primary-foreground disabled:border-border disabled:bg-send-disabled disabled:text-muted-foreground disabled:opacity-100",
        destructive:
          "btn-solid bg-danger text-primary-foreground disabled:border-border disabled:bg-send-disabled disabled:text-muted-foreground disabled:opacity-100",
        outline: "btn-raised",
        ghost: "text-muted-foreground hover:bg-hover hover:text-foreground active:bg-[rgb(110_74_0_/_0.08)] aria-expanded:bg-hover aria-expanded:text-foreground",
        slot: "btn-honey",
        send: "send-button disabled:opacity-100",
      },
      size: {
        default: "h-9 px-4 text-minor",
        sm: "h-8 px-3 text-minor",
        icon: "size-9",
        "icon-lg": "size-9",
        "icon-sm": "size-8",
      },
    },
    compoundVariants: [
      { variant: "ghost", size: ["default", "sm"], class: "text-foreground" },
      { variant: "slot", class: "[&_svg:not([class*='size-'])]:size-pixel-md" },
      { variant: "slot", size: "default", class: "h-8 px-3" },
      { variant: "slot", size: "icon", class: "size-8" },
      { variant: "slot", size: "icon-lg", class: "size-9" },
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
