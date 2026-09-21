import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Badge                                                                      */
/* -------------------------------------------------------------------------- */

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-secondary text-secondary-foreground",
        success:
          "border-emeraldBrand-500/25 bg-emeraldBrand-500/12 text-emeraldBrand-700 dark:text-emeraldBrand-300",
        warning:
          "border-amber-500/30 bg-amber-500/12 text-amber-700 dark:text-amber-300",
        destructive: "border-destructive/30 bg-destructive/12 text-destructive",
        info: "border-sky-500/30 bg-sky-500/12 text-sky-700 dark:text-sky-300",
        outline: "border-border text-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Maps a domain status onto the right badge tone in one place. */
export function statusBadgeVariant(status: string | null | undefined): BadgeProps["variant"] {
  switch (status) {
    case "COMPLETED":
    case "REWARDED":
    case "CREDITED":
    case "VERIFIED":
    case "ACTIVE":
    case "QUALIFIED":
    case "CLEARED":
    case "APPROVED":
      return "success";
    case "PENDING":
    case "PENDING_ADMIN_APPROVAL":
    case "PROCESSING":
    case "REVIEW":
    case "REVIEWING":
    case "REQUIRES_REVIEW":
    case "PAUSED":
    case "NOT_STARTED":
      return "warning";
    case "FAILED":
    case "REJECTED":
    case "CANCELLED":
    case "SUSPENDED":
    case "RESTRICTED":
    case "CLOSED":
    case "EXPIRED":
    case "CONFIRMED":
      return "destructive";
    default:
      return "default";
  }
}

/* -------------------------------------------------------------------------- */
/* Separator / Skeleton / Progress / Avatar                                   */
/* -------------------------------------------------------------------------- */

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("tc-skeleton h-4 w-full", className)} aria-hidden {...props} />;
}

export function Progress({
  value,
  className,
  indicatorClassName,
  label,
}: {
  value: number;
  className?: string;
  indicatorClassName?: string;
  label?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <ProgressPrimitive.Root
      value={clamped}
      aria-label={label}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <ProgressPrimitive.Indicator
        className={cn("h-full w-full flex-1 bg-primary transition-transform duration-300", indicatorClassName)}
        style={{ transform: `translateX(-${100 - clamped}%)` }}
      />
    </ProgressPrimitive.Root>
  );
}

export const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)}
    {...props}
  />
));
Avatar.displayName = "Avatar";

export const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-secondary text-sm font-semibold",
      className,
    )}
    {...props}
  />
));
AvatarFallback.displayName = "AvatarFallback";

/* -------------------------------------------------------------------------- */
/* Alert                                                                      */
/* -------------------------------------------------------------------------- */

const alertVariants = cva("flex gap-3 rounded-xl border p-4 text-sm", {
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      info: "border-sky-500/25 bg-sky-500/8 text-foreground",
      success: "border-emeraldBrand-500/25 bg-emeraldBrand-500/8 text-foreground",
      warning: "border-amber-500/30 bg-amber-500/8 text-foreground",
      destructive: "border-destructive/30 bg-destructive/8 text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

const ICONS = {
  default: Info,
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  destructive: XCircle,
} as const;

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  title?: string;
}

export function Alert({ className, variant = "default", title, children, ...props }: AlertProps) {
  const key = (variant ?? "default") as keyof typeof ICONS;
  const Icon = ICONS[key] ?? Info;

  return (
    <div role="status" className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          key === "success" && "text-emeraldBrand-600 dark:text-emeraldBrand-400",
          key === "warning" && "text-amber-600 dark:text-amber-400",
          key === "destructive" && "text-destructive",
          (key === "info" || key === "default") && "text-sky-600 dark:text-sky-400",
        )}
        aria-hidden
      />
      <div className="space-y-1">
        {title ? <p className="font-semibold leading-none">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty state                                                                */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon ? (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
          <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
