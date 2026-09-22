import { Suspense } from "react";
import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";

export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Register for TaskCash Pro. Your wallet, referral code and ledger are provisioned securely by the server.",
};

export default function RegisterPage() {
  return (
    /*
      Padding is one step tighter on a phone and reverts at `sm`. The card is the
      tallest thing on the sign-up screen, so 4px off each edge is 16px off the
      page — and it buys nothing back on a desktop where the space is free.
    */
    <Card>
      <CardHeader className="p-4 sm:p-5">
        <CardTitle className="text-base">Create your account</CardTitle>
        <CardDescription className="text-xs">
          It takes a minute. Your wallet and referral code are created for you.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 sm:p-5 sm:pt-0">
        <Suspense
          fallback={
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-10 sm:h-11" />
              ))}
            </div>
          }
        >
          <RegisterForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
