import { LogIn, LogOut } from "lucide-react";
import { useState, type FormEvent } from "react";
import { signIn, signOut, type ForgeUser } from "../lib/forgeweb-api";

export default function OwnerAccess({ user, loading, busy, onChanged }: { user: ForgeUser | null; loading: boolean; busy: boolean; onChanged: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [register, setRegister] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true); setError("");
    try { await signIn(username, password, register); await onChanged(); }
    catch { setError(register ? "Account creation failed. Use a unique username and a password of at least 12 characters." : "Sign-in failed. Check your username and password."); }
    finally { setPassword(""); setPending(false); }
  };
  const logout = async () => {
    setPending(true); setError("");
    try { await signOut(); await onChanged(); }
    catch { setError("Sign-out failed. Try again."); }
    finally { setPending(false); }
  };
  return <div className="owner-access">
    {loading ? <p role="status">Loading account...</p> : user ? <div className="owner-account"><span>{user.username}</span><button type="button" title="Sign out" aria-label="Sign out" disabled={busy || pending} onClick={() => void logout()}><LogOut size={16} /></button></div> :
      <form onSubmit={submit}>
        <h3>{register ? "Create local account" : "Sign in to ForgeWeb"}</h3>
        <label>Username<input required value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} pattern="[a-zA-Z0-9_.\-]+" /></label>
        <label>Password<input required type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={register ? "new-password" : "current-password"} minLength={12} maxLength={128} /></label>
        <button className="button button-acid" disabled={pending} type="submit"><LogIn size={16} />{pending ? "Please wait..." : register ? "Create account" : "Sign in"}</button>
        <button className="owner-account-switch" type="button" disabled={pending} onClick={() => { setRegister(!register); setError(""); setPassword(""); }}>{register ? "Already have an account? Sign in" : "Create local account"}</button>
      </form>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
  </div>;
}
