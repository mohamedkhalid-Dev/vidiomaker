import type { Metadata } from "next";
import ForgotPasswordForm from "./ForgotPasswordForm";

export const metadata: Metadata = {
  // Renders as "Forgot password — Vidiomaker" via the title template.
  title: "Forgot password",
  description: "Reset your Vidiomaker password with an email link.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/forgot-password" },
};

// /forgot-password — server wrapper (owns metadata) around the client form.
export default function ForgotPasswordPage(): React.ReactElement {
  return (
    <section
      aria-labelledby="forgot-heading"
      style={{ maxWidth: "28rem", margin: "0 auto" }}
    >
      <h1 id="forgot-heading">Forgot password</h1>
      <p className="auth-msg" style={{ marginBottom: "1rem" }}>
        Enter your account email and we’ll send you a link to set a new password.
      </p>
      <ForgotPasswordForm />
    </section>
  );
}
