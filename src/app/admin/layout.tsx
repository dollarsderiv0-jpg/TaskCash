import { guardAdminPage } from "@/lib/auth/guards";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Admin layout.
 *
 * guardAdminPage() re-reads the caller's role from the database on every
 * request and redirects anyone who is not an active administrator. Visiting
 * /admin therefore grants nothing on its own.
 */
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await guardAdminPage();

  return (
    <AdminShell
      admin={{
        fullName: session.profile.full_name,
        email: session.profile.email,
        role: session.profile.role,
      }}
    >
      {children}
    </AdminShell>
  );
}
