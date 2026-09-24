import {
  LayoutDashboard,
  PlayCircle,
  Package,
  Wallet,
  ReceiptText,
  Users,
  UserCircle,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  /** Shorter label for the five-slot mobile tab bar. */
  shortLabel?: string;
  icon: LucideIcon;
  /** Which bar this destination belongs to. */
  inSidebar: boolean;
  inMobileBar: boolean;
}

/**
 * Order matters: it is the visual order in both bars, and the mobile bar is the
 * subset flagged `inMobileBar`, kept to five slots so the labels never truncate.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", shortLabel: "Home", icon: LayoutDashboard, inSidebar: true, inMobileBar: true },
  { href: "/watch", label: "Watch & Earn", shortLabel: "Watch", icon: PlayCircle, inSidebar: true, inMobileBar: true },
  { href: "/packages", label: "Packages", icon: Package, inSidebar: true, inMobileBar: false },
  { href: "/wallet", label: "Wallet", icon: Wallet, inSidebar: true, inMobileBar: true },
  { href: "/transactions", label: "Transactions", icon: ReceiptText, inSidebar: true, inMobileBar: false },
  { href: "/referrals", label: "Referrals", shortLabel: "Refer", icon: Users, inSidebar: true, inMobileBar: true },
  { href: "/profile", label: "Profile", icon: UserCircle, inSidebar: true, inMobileBar: true },
];

export const SIDEBAR_NAV = NAV_ITEMS.filter((item) => item.inSidebar);
export const MOBILE_NAV = NAV_ITEMS.filter((item) => item.inMobileBar);

export const isActivePath = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);
