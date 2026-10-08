import type { Metadata } from "next";
import LoginForm from "./LoginForm";

export const metadata: Metadata = {
  // Renders as "Log in — Vidiomaker" via the title template in app/layout.tsx.
  title: "Log in",
  description: "Log in to Vidiomaker with your email and password.",
  robots: { index: false, follow: true },
  alternates: { canonical: "/login" },
};

// /login — server wrapper (owns metadata) around the client password form.
// ?next= is read here on the server and passed down, so the form needs no
// useSearchParams/Suspense. After sign-in the form pushes to `next`.
export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}): React.ReactElement {
  const next = typeof searchParams?.next === "string" ? searchParams.next : undefined;
  return (
    <section aria-labelledby="login-heading" style={{ maxWidth: "28rem", margin: "0 auto" }}>
      <h1 id="login-heading">Welcome back — log in</h1>
      <p className="auth-msg" style={{ marginBottom: "1rem" }}>
        Log in with Google, or continue with your email and password.
      </p>
      <LoginForm next={next} />
    </section>
  );
}
