import Link from "next/link";
import { Alert, Badge } from "@/components/ui/misc";
import type { LegalDocument } from "@/content/legal";

export function LegalDoc({ doc }: { doc: LegalDocument }) {
  return (
    <article className="container max-w-3xl py-14">
      <Badge variant="warning">{doc.updated}</Badge>
      <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{doc.title}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{doc.summary}</p>

      <Alert variant="warning" className="mt-6" title="Draft pending legal review">
        <p>
          This document describes how the platform actually operates, but it is not a substitute for
          legal advice. The operator must publish its real legal entity name, registration details
          and contact information before launch.
        </p>
      </Alert>

      <div className="mt-10 space-y-9">
        {doc.sections.map((section) => (
          <section key={section.heading} id={slugify(section.heading)}>
            <h2 className="text-lg font-semibold tracking-tight">{section.heading}</h2>
            {section.paragraphs?.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className="mt-3 text-sm leading-relaxed text-muted-foreground">
                {paragraph}
              </p>
            ))}
            {section.bullets ? (
              <ul className="mt-3 space-y-2.5">
                {section.bullets.map((bullet) => (
                  <li key={bullet.slice(0, 40)} className="flex gap-2.5 text-sm text-muted-foreground">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>

      <div className="mt-12 flex flex-wrap gap-x-4 gap-y-2 border-t border-border pt-6 text-sm">
        <Link className="text-primary hover:underline" href="/terms">
          Terms
        </Link>
        <Link className="text-primary hover:underline" href="/privacy">
          Privacy
        </Link>
        <Link className="text-primary hover:underline" href="/rewards-policy">
          Rewards Policy
        </Link>
        <Link className="text-primary hover:underline" href="/withdrawal-policy">
          Withdrawal Policy
        </Link>
        <Link className="text-primary hover:underline" href="/refund-policy">
          Refund Policy
        </Link>
        <Link className="text-primary hover:underline" href="/contact">
          Contact
        </Link>
      </div>
    </article>
  );
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
