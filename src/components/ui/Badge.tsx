import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type Variant = "default" | "solar" | "success" | "warning" | "danger" | "info" | "outline";

const VARIANTS: Record<Variant, string> = {
  default: "bg-bg-subtle text-fg-muted",
  solar: "bg-soleil-500/12 text-soleil-700 dark:text-soleil-300",
  success: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  danger: "bg-red-500/12 text-red-700 dark:text-red-400",
  info: "bg-astro-500/12 text-astro-700 dark:text-astro-400",
  outline: "border border-border-strong text-fg-muted",
};

export function Badge({
  variant = "default",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5 whitespace-nowrap",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
