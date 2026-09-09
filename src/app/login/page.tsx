"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        setError(data.error || "Accesso non riuscito");
        return;
      }
      setPassword("");
      router.replace("/");
      router.refresh();
    } catch {
      setError("Errore di rete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      <section className="login-shell">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><span>S</span></div>
          <div className="brand-copy"><strong>SCALPER</strong><span>XAUUSD · ACCESSO RISERVATO</span></div>
        </div>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="dashboard-password">Password dashboard</label>
          <input
            id="dashboard-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            autoFocus
          />
          <button type="submit" className="resume-button" disabled={busy || password.length === 0}>
            {busy ? "Verifica…" : "ENTRA"}
          </button>
          {error ? <p className="login-error">{error}</p> : null}
        </form>
      </section>
    </main>
  );
}
