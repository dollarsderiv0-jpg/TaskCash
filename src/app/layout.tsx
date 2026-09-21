import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/toast";
import { Pwa } from "@/components/app/pwa";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: {
    default: "TaskCash Pro — Watch. Complete. Earn.",
    template: "%s · TaskCash Pro",
  },
  description:
    "Earn rewards from eligible online activities. Complete sponsored video campaigns and approved tasks, track every transaction transparently, and request withdrawals reviewed by our administration team.",
  applicationName: "TaskCash Pro",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icon.svg" }],
  },
  appleWebApp: {
    capable: true,
    title: "TaskCash Pro",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    title: "TaskCash Pro — Watch. Complete. Earn.",
    description:
      "Complete eligible online activities and earn rewards from participating campaigns.",
    type: "website",
    siteName: "TaskCash Pro",
  },
  robots: {
    index: true,
    follow: true,
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0e1a33" },
    { media: "(prefers-color-scheme: light)", color: "#f2f6fb" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans`}>
        {/* Skip link: keyboard users should never have to tab through the nav. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-primary-foreground"
        >
          Skip to main content
        </a>
        <ToastProvider>
          {children}
          {/* Service-worker registration and the install prompt. Renders nothing
              unless the browser offers an install and the user has not dismissed
              it, so there is no layout cost on the server or on iOS Safari. */}
          <Pwa />
        </ToastProvider>
      </body>
    </html>
  );
}
