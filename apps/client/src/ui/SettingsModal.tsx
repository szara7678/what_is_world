import { useEffect, useState } from "react";
import { API_BASE } from "../net/endpoints";
import { adminFetch } from "../net/adminAuth";

interface PublicConfig {
  provider: "mock" | "openrouter" | "local-proxy";
  model: string;
  baseUrl: string;
  tickIntervalMs: number;
  maxActorsPerTick: number;
  enabled: boolean;
  reflectIntervalMs: number;
  hasApiKey: boolean;
  updatedAt: number;
}
interface ModelPreset { label: string; value: string; note: string }

const LOCAL_PROXY_DEFAULTS = {
  baseUrl: "http://127.0.0.1:18796/v1",
  model: "gpt-5.5-mini"
};

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [models, setModels] = useState<ModelPreset[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [provider, setProvider] = useState<"mock" | "openrouter" | "local-proxy">("mock");
  const [tickMs, setTickMs] = useState(8000);
  const [maxActors, setMaxActors] = useState(2);
  const [enabled, setEnabled] = useState(false);
  const [reflectMs, setReflectMs] = useState(90000);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/config/brain`)
      .then((r) => r.json())
      .then((json: { config: PublicConfig; models: ModelPreset[] }) => {
        setCfg(json.config);
        setModels(json.models);
        setProvider(json.config.provider);
        setModel(json.config.model);
        setBaseUrl(json.config.baseUrl);
        setTickMs(json.config.tickIntervalMs);
        setMaxActors(json.config.maxActorsPerTick);
        setEnabled(json.config.enabled);
        setReflectMs(json.config.reflectIntervalMs ?? 90000);
      })
      .catch((e) => setMsg(`Load failed: ${e}`));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        provider, model, baseUrl,
        tickIntervalMs: tickMs,
        maxActorsPerTick: maxActors,
        enabled,
        reflectIntervalMs: reflectMs
      };
      if (apiKey) body.apiKey = apiKey;
      const res = await adminFetch(`${API_BASE}/config/brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json() as { ok: boolean; config: PublicConfig };
      if (json.ok) {
        setCfg(json.config);
        setApiKey("");
        setMsg("✔ Saved.");
      } else {
        setMsg("Save failed");
      }
    } catch (e) {
      setMsg(`Error: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚙️ Brain settings</h2>
        <div className="sub">Configure OpenRouter token and model. Token is stored on the server only.</div>

        <div className="form-row">
          <label>Provider</label>
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value as "mock" | "openrouter" | "local-proxy";
              setProvider(next);
              if (next === "local-proxy") {
                setBaseUrl(LOCAL_PROXY_DEFAULTS.baseUrl);
                setModel(LOCAL_PROXY_DEFAULTS.model);
              }
            }}
          >
            <option value="mock">Mock (rule-based dummy)</option>
            <option value="openrouter">OpenRouter</option>
            <option value="local-proxy">Local Proxy</option>
          </select>
          <div className="hint">Verify with Mock first, then switch to OpenRouter or local proxy.</div>
        </div>

        <div className="form-row">
          <label>Base URL</label>
          <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" />
        </div>

        <div className="form-row">
          <label>API Key {cfg?.hasApiKey ? <span style={{ color: "var(--accent3)" }}>(saved)</span> : <span style={{ color: "var(--text3)" }}>(미Settings)</span>}</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cfg?.hasApiKey ? "Enter new key to replace" : "sk-or-v1-..."} />
          <div className="hint">Not shown on screen. Re-enter only to change.</div>
        </div>

        <div className="form-row">
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.label} — {m.note}</option>
            ))}
            <option value={model}>{model} (custom)</option>
          </select>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="openai/gpt-4o-mini"
            style={{ marginTop: 6 }}
          />
          <div className="hint">Models not in the list can be entered directly. e.g. <code>z-ai/glm-4.6</code></div>
        </div>

        <div className="form-row row-horiz">
          <label>Tick (ms)</label>
          <input type="number" min={1000} max={60000} step={500} value={tickMs} onChange={(e) => setTickMs(Number(e.target.value))} style={{ width: 100 }} />
          <label>Concurrent residents</label>
          <input type="number" min={1} max={10} value={maxActors} onChange={(e) => setMaxActors(Number(e.target.value))} style={{ width: 60 }} />
        </div>

        <div className="form-row row-horiz">
          <label>Reflection interval (ms)</label>
          <input type="number" min={15000} max={300000} step={5000} value={reflectMs} onChange={(e) => setReflectMs(Number(e.target.value))} style={{ width: 110 }} />
          <span className="hint">🪞 When 3+ observations collected, summarize and update soul's values/goals</span>
        </div>

        <div className="form-row row-horiz">
          <input id="cfg-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <label htmlFor="cfg-enabled">Enable brain loop (residents only think when checked)</label>
        </div>

        {msg && <div style={{ color: "var(--text2)", fontSize: 12, marginBottom: 10 }}>{msg}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="ghost-btn" onClick={onClose} disabled={saving}>Close</button>
          <button className="primary-btn" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
