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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Create your account</CardTitle>
        <CardDescription className="text-xs">
          It takes a minute. Your wallet and referral code are created for you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense
          fallback={
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-11" />
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
