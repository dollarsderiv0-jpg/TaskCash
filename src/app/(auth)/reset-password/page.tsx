import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/password-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/misc";

export const metadata: Metadata = { title: "Set a new password" };

export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Set a new password</CardTitle>
        <CardDescription>
          Choose a strong password you have not used anywhere else.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Alert variant="info">
          <p>
            This page only works while your password reset link is still valid. If it has expired,
            request a new link.
          </p>
        </Alert>
        <ResetPasswordForm />
      </CardContent>
    </Card>
  );
}
