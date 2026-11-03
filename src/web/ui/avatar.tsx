import * as AvatarPrimitive from "@radix-ui/react-avatar";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

export function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex size-10 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

export function AvatarFallback({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn("flex size-full items-center justify-center", className)}
      {...props}
    />
  );
}
