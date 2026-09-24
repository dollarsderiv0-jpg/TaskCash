"use client";

import * as React from "react";
import Link from "next/link";
import { formatMoney } from "@/lib/format";
import { useStore } from "@/lib/store";
import { Brand } from "./brand";

export function Header({ right }: { right?: React.ReactNode }) {
  const { totalBalance } = useStore();

  return (
    <header className="sticky top-0 z-30 border-b border-hairline bg-surface/85 backdrop-blur lg:border-b-0 lg:bg-transparent lg:backdrop-blur-none">
      <div className="mx-auto flex h-14 max-w-[1120px] items-center justify-between gap-3 px-4 sm:h-16 sm:px-6">
        <Brand />
        <div className="flex items-center gap-2">
          {right}
          <Link
            href="/wallet"
            className="flex items-center gap-2 rounded-full border border-hairline bg-card px-3 py-1.5 transition hover:border-flame/50"
            aria-label="Wallet balance"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-cash" aria-hidden />
            <span className="tnum text-[12px] font-bold text-white sm:text-[13px]">
              {formatMoney(totalBalance)}
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}
