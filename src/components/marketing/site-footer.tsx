import Link from "next/link";
import { Logo } from "@/components/brand/logo";
import { getPublicSettings } from "@/lib/settings";

const LINKS = {
  product: [
    { href: "/how-it-works", label: "How It Works" },
    { href: "/earn", label: "Earn" },
    { href: "/referrals", label: "Referral Program" },
    { href: "/faq", label: "FAQ" },
  ],
  legal: [
    { href: "/terms", label: "Terms" },
    { href: "/privacy", label: "Privacy" },
    { href: "/cookies", label: "Cookie Policy" },
    { href: "/rewards-policy", label: "Rewards Policy" },
    { href: "/withdrawal-policy", label: "Withdrawal Policy" },
    { href: "/refund-policy", label: "Refund Policy" },
  ],
  support: [
    { href: "/support", label: "Help & Support" },
    { href: "/contact", label: "Contact" },
    { href: "/responsible-use", label: "Responsible Use" },
  ],
};

export async function SiteFooter() {
  const settings = await getPublicSettings();
  const identity = settings.identity;

  // Platform identity is never invented: if the business owner has not
  // supplied it, we say so plainly rather than printing a placeholder entity.
  const hasIdentity = identity.legalName !== "Not configured — see Settings → Platform details";

  return (
    <footer className="border-t border-border bg-card/40">
      <div className="container grid gap-10 py-12 md:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Logo showTagline />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
            TaskCash Pro is a rewards platform. Users complete eligible sponsored video campaigns
            and approved tasks, and rewards are credited to an internal wallet ledger. Rewards
            depend on campaign rules and availability — they are not an investment product and no
            return is guaranteed.
          </p>

          <div className="mt-6 space-y-1 text-xs text-muted-foreground">
            {hasIdentity ? (
              <>
                <p className="font-semibold text-foreground">{identity.legalName}</p>
                {identity.registrationDetails ? <p>{identity.registrationDetails}</p> : null}
                {identity.businessAddress ? <p>{identity.businessAddress}</p> : null}
                {identity.supportEmail ? (
                  <p>
                    Support:{" "}
                    <a className="underline underline-offset-2" href={`mailto:${identity.supportEmail}`}>
                      {identity.supportEmail}
                    </a>
                  </p>
                ) : null}
                {identity.supportPhone ? <p>Phone: {identity.supportPhone}</p> : null}
              </>
            ) : (
              <p>
                Operator details are not published yet. The business owner must supply the legal
                entity name, registration details and support contacts in the platform settings
                before launch.
              </p>
            )}
          </div>
        </div>

        <FooterColumn title="Product" links={LINKS.product} />
        <FooterColumn title="Legal" links={LINKS.legal} />
        <FooterColumn title="Support" links={LINKS.support} />
      </div>

      <div className="border-t border-border">
        <div className="container flex flex-col gap-3 py-5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} TaskCash Pro. All rights reserved.</p>
          <p className="max-w-xl sm:text-right">
            Payments are processed by our payment partner. TaskCash Pro is not a bank, investment
            manager or licensed financial adviser. Reward availability depends on active campaigns.
          </p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: { href: string; label: string }[];
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="mt-3 space-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
