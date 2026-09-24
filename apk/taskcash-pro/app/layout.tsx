import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/toast";
import { DemoStoreProvider } from "@/lib/store";

export const metadata: Metadata = {
  title: "TaskCash Pro — Rewards Dashboard",
  description:
    "TaskCash Pro demo interface: watch tasks, packages and a mock wallet. Prototype only — no real money moves.",
};

export const viewport: Viewport = {
  themeColor: "#0B1020",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-surface text-white">
        <DemoStoreProvider>
          <ToastProvider>{children}</ToastProvider>
        </DemoStoreProvider>
      </body>
    </html>
  );
}
