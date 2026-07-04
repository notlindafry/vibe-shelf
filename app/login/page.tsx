"use client";

import { useState } from "react";
import { login } from "@/lib/api";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      // Full navigation so middleware sees the new session cookie.
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect password");
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="wordmark">
          vibe<span className="dash">-</span>shelf
        </div>
        <p>A private catalogue of a shared vinyl shelf. Enter the password to browse.</p>
        <form className="login-form" onSubmit={onSubmit}>
          <label className="sr-only" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
          {error && <div className="error">{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={busy || !password}>
            {busy ? <span className="spin" aria-hidden /> : "Enter"}
          </button>
        </form>
      </div>
    </main>
  );
}
