import type { Metadata } from "next";
import UpdatePasswordForm from "./UpdatePasswordForm";

export const metadata: Metadata = {
  // Renders as "Set a new password — Vidiomaker" via the title template.
  title: "Set a new password",
  description: "Choose a new Vidiomaker password after a reset request.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/update-password" },
};

// /update-password — server wrapper (owns metadata) around the client form.
// Landing target of the reset-email link via /auth/callback?next=/update-password.
export default function UpdatePasswordPage(): React.ReactElement {
  return (
    <section
      aria-labelledby="update-heading"
      style={{ maxWidth: "28rem", margin: "0 auto" }}
    >
      <h1 id="update-heading">Set a new password</h1>
      <UpdatePasswordForm />
    </section>
  );
}
