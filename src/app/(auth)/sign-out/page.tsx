import type { Metadata } from "next";
import { SignOutPanel } from "@/components/auth/sign-out-panel";

/**
 * `/sign-out`
 *
 * Deliberately NOT in the middleware's `AUTH_ROUTES`. The routes listed there
 * are the ones a signed-in visitor is bounced away from — and this is the one
 * screen a signed-in visitor has to be able to reach.
 *
 * Reached two ways, which is why it does its own work: the "Sign out" control in
 * the app and admin menus lands here, and it is also a plain address someone can
 * open directly. Either way the panel ends the session and confirms it.
 */
export const metadata: Metadata = {
  title: "Signed out",
  // Nothing here to index, and it would only ever show stale state.
  robots: { index: false, follow: false },
};

export default function SignOutPage() {
  return <SignOutPanel />;
}
