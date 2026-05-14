import { useState } from "react";
import { API_BASE } from "../net/endpoints";
import { getAdminToken, setAdminToken } from "../net/adminAuth";

export function AdminLoginModal({ onClose }: { onClose: () => void }) {
  const existing = getAdminToken();
  const [token, setToken] = useState(existing);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const trySave = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_BASE}/admin/world/pause`, {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      });
      const trial = await fetch(`${API_BASE}/admin/world/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({})
      });
      if (trial.status === 401) {
        setMsg("Token rejected (401).");
        return;
      }
      if (!res.ok && !trial.ok) {
        setMsg(`Server error ${trial.status}.`);
        return;
      }
      setAdminToken(token);
      setMsg("Saved. Admin actions unlocked. Reload may be needed for the world room.");
    } catch (err) {
      setMsg(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    setAdminToken("");
    setToken("");
    setMsg("Logged out.");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>🔐 Admin login</h2>
        <div className="sub">Paste the admin token to unlock world editing, brain toggle, oracle, and other operator actions. Visitors don't need this.</div>

        <div className="form-row">
          <label>Admin token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token from server WIW_ADMIN_TOKEN env"
            autoComplete="new-password"
          />
          <div className="hint">Stored in localStorage. Use a private window if shared device.</div>
        </div>

        {msg && <div style={{ color: "var(--text2)", fontSize: 12, marginBottom: 10 }}>{msg}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "space-between" }}>
          <button className="ghost-btn" onClick={logout} disabled={busy}>Log out</button>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="ghost-btn" onClick={onClose} disabled={busy}>Close</button>
            <button className="primary-btn" onClick={trySave} disabled={busy || !token.trim()}>{busy ? "Verifying..." : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
