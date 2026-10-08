import type { Metadata } from "next";
import SignupForm from "./SignupForm";

export const metadata: Metadata = {
  // Renders as "Sign up — Vidiomaker" via the title template in app/layout.tsx.
  title: "Sign up",
  description: "Create a Vidiomaker account with your email and password.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/signup" },
};

// /signup — server wrapper (owns metadata) around the client password form.
// ?next= is read here on the server and passed down, so the form needs no
// useSearchParams/Suspense.
export default function SignupPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}): React.ReactElement {
  const next = typeof searchParams?.next === "string" ? searchParams.next : undefined;
  return (
    <section aria-labelledby="signup-heading" style={{ maxWidth: "28rem", margin: "0 auto" }}>
      <h1 id="signup-heading">Create your account</h1>
      <p className="auth-msg" style={{ marginBottom: "1rem" }}>
        Sign up with Google, or continue with your email and password.
      </p>
      <SignupForm next={next} />
    </section>
  );
}
