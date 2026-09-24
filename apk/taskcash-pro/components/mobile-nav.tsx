"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MOBILE_NAV, isActivePath } from "@/lib/nav";
import { cn } from "@/lib/format";

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-base/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto flex max-w-[560px] items-stretch">
        {MOBILE_NAV.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  /* 48px of touch target plus the label — comfortably over the
                     44px minimum even on the smallest phones. */
                  "flex min-h-[56px] flex-col items-center justify-center gap-1 px-1 py-2 transition",
                  active ? "text-flame-400" : "text-muted hover:text-white",
                )}
              >
                <Icon className="h-[19px] w-[19px]" aria-hidden />
                <span className="text-[10px] font-semibold leading-none">
                  {item.shortLabel ?? item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
