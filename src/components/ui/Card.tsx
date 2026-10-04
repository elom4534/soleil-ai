import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 pt-4 pb-2 sm:px-5 sm:pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-[19px] font-normal tracking-tight text-fg sm:text-[21px]", className)}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3 sm:px-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("border-t border-border-subtle px-4 py-3 sm:px-5", className)}
      {...props}
    />
  );
}

/** En-tête de section avec titre + sous-titre optionnel + action à droite. */
export function SectionHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3", className)}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="page-title text-[22px] leading-tight sm:text-[26px]">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-[13px] text-fg-muted">{subtitle}</p>
          ) : null}
        </div>
        {action}
      </div>
      <hr className="dotted-rule" />
    </div>
  );
}
