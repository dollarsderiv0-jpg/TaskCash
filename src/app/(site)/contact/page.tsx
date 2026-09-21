import type { Metadata } from "next";
import { Mail, MapPin, Phone, ShieldAlert } from "lucide-react";
import { Alert } from "@/components/ui/misc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getPublicSettings } from "@/lib/settings";

export const metadata: Metadata = {
  title: "Contact & Support",
  description: "How to reach TaskCash Pro support, and what to include in your request.",
};

export const dynamic = "force-dynamic";

const NOT_CONFIGURED = "Not configured — see Settings → Platform details";

export default async function ContactPage() {
  const { identity } = await getPublicSettings();
  const configured = identity.supportEmail !== NOT_CONFIGURED;

  return (
    <div className="container max-w-3xl py-14">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Contact & Support</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        For anything relating to your account, a payment or a withdrawal, include the transaction
        reference from your history so we can reconcile it against provider records.
      </p>

      {!configured ? (
        <Alert variant="warning" className="mt-6" title="Support details not published yet">
          <p>
            The operator has not yet supplied support contact details. They must be added in the
            platform settings before launch — we will not invent an email address or phone number
            here.
          </p>
        </Alert>
      ) : null}

      <div className="mt-8 grid gap-5 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-orangeBrand-500" aria-hidden />
              Support
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {identity.supportEmail !== NOT_CONFIGURED ? (
              <p>
                <a className="underline underline-offset-2" href={`mailto:${identity.supportEmail}`}>
                  {identity.supportEmail}
                </a>
              </p>
            ) : (
              <p>Not published yet.</p>
            )}
            {identity.supportPhone !== NOT_CONFIGURED ? (
              <p className="flex items-center gap-2">
                <Phone className="h-3.5 w-3.5" aria-hidden />
                {identity.supportPhone}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-orangeBrand-500" aria-hidden />
              Privacy & data protection
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {identity.privacyContact !== NOT_CONFIGURED ? (
              <p>{identity.privacyContact}</p>
            ) : (
              <p>Not published yet.</p>
            )}
            {identity.dataProtectionNote !== NOT_CONFIGURED ? (
              <p>{identity.dataProtectionNote}</p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-orangeBrand-500" aria-hidden />
            Operator details
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Legal entity: </span>
            {identity.legalName}
          </p>
          <p>
            <span className="font-medium text-foreground">Registration details: </span>
            {identity.registrationDetails}
          </p>
          <p>
            <span className="font-medium text-foreground">Business address: </span>
            {identity.businessAddress}
          </p>
          <p>
            <span className="font-medium text-foreground">Payment provider disclosure: </span>
            {identity.paymentProviderDetails}
          </p>
        </CardContent>
      </Card>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>What to include</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {[
              "The email address on your account.",
              "The transaction reference — deposit references start with TCD, and video rewards with VRW.",
              "The amount, currency and approximate date and time.",
              "A short description of what happened and what you expected.",
            ].map((item) => (
              <li key={item} className="flex gap-2.5">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
