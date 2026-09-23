import { redirect } from "next/navigation";

/**
 * Packages now live on Watch & Earn.
 *
 * The catalogue and its payment flow moved there, so this route is kept as a
 * redirect rather than deleted. Deleting it would 404 every link that already
 * points here — bookmarks, and more importantly the `notify_user` calls inside
 * `package_purchase`, which store '/dashboard/packages' as the destination of a
 * "package activated" notification. A redirect keeps those working without a
 * migration that exists only to change a string.
 */
export default function PackagesPage() {
  redirect("/dashboard/watch");
}
