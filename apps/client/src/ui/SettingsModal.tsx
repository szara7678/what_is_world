import { useEffect, useState } from "react";
import { API_BASE } from "../net/endpoints";

interface PublicConfig {
  provider: "openrouter" | "mock";
  model: string;
  baseUrl: string;
  tickIntervalMs: number;
  maxActorsPerTick: number;
  enabled: boolean;
  hasApiKey: boolean;
  updatedAt: number;
}
interface ModelPreset { label: string; value: string; note: string }

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [models, setModels] = useState<ModelPreset[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [provider, setProvider] = useState<"openrouter" | "mock">("mock");
  const [tickMs, setTickMs] = useState(8000);
  const [maxActors, setMaxActors] = useState(2);
  const [enabled, setEnabled] = useState(false);
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
      })
      .catch((e) => setMsg(`로드 실패: ${e}`));
  }, []);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        provider, model, baseUrl,
        tickIntervalMs: tickMs,
        maxActorsPerTick: maxActors,
        enabled
      };
      if (apiKey) body.apiKey = apiKey;
      const res = await fetch(`${API_BASE}/config/brain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = await res.json() as { ok: boolean; config: PublicConfig };
      if (json.ok) {
        setCfg(json.config);
        setApiKey("");
        setMsg("✔ 저장됐어요.");
      } else {
        setMsg("저장 실패");
      }
    } catch (e) {
      setMsg(`오류: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>⚙️ 두뇌 설정</h2>
        <div className="sub">OpenRouter 토큰과 모델을 설정해요. 토큰은 서버에만 저장돼요.</div>

        <div className="form-row">
          <label>Provider</label>
          <select value={provider} onChange={(e) => setProvider(e.target.value as "openrouter" | "mock")}>
            <option value="mock">Mock (규칙 기반 더미)</option>
            <option value="openrouter">OpenRouter</option>
          </select>
          <div className="hint">처음엔 Mock 으로 동작 확인 → 토큰 넣고 OpenRouter 로 전환해보세요.</div>
        </div>

        <div className="form-row">
          <label>Base URL</label>
          <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" />
        </div>

        <div className="form-row">
          <label>API Key {cfg?.hasApiKey ? <span style={{ color: "var(--accent3)" }}>(저장됨)</span> : <span style={{ color: "var(--text3)" }}>(미설정)</span>}</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={cfg?.hasApiKey ? "바꾸려면 새 키 입력" : "sk-or-v1-..."} />
          <div className="hint">화면에 표시되지 않습니다. 바꾸고 싶을 때만 다시 입력하세요.</div>
        </div>

        <div className="form-row">
          <label>Model</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.label} — {m.note}</option>
            ))}
            <option value={model}>{model} (사용자 지정)</option>
          </select>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="openai/gpt-4o-mini"
            style={{ marginTop: 6 }}
          />
          <div className="hint">목록에 없는 모델은 직접 입력해도 돼요. 예: <code>z-ai/glm-4.6</code></div>
        </div>

        <div className="form-row row-horiz">
          <label>Tick (ms)</label>
          <input type="number" min={2000} max={60000} step={500} value={tickMs} onChange={(e) => setTickMs(Number(e.target.value))} style={{ width: 100 }} />
          <label>동시 주민</label>
          <input type="number" min={1} max={10} value={maxActors} onChange={(e) => setMaxActors(Number(e.target.value))} style={{ width: 60 }} />
        </div>

        <div className="form-row row-horiz">
          <input id="cfg-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <label htmlFor="cfg-enabled">두뇌 루프 켜기 (체크해야 주민들이 생각해요)</label>
        </div>

        {msg && <div style={{ color: "var(--text2)", fontSize: 12, marginBottom: 10 }}>{msg}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="ghost-btn" onClick={onClose} disabled={saving}>닫기</button>
          <button className="primary-btn" onClick={save} disabled={saving}>{saving ? "저장 중…" : "저장"}</button>
        </div>
      </div>
    </div>
  );
}
