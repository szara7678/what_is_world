import { useState } from "react";
import { App as EditorApp } from "./App";
import { ObservatoryShell } from "./ObservatoryShell";
import "./cozy-theme.css";

export function Root() {
  const [mode, setMode] = useState<"observe" | "edit">(() => {
    try {
      const m = localStorage.getItem("wiw.mode");
      if (m === "edit" || m === "observe") return m;
    } catch {}
    return "observe";
  });

  const switchTo = (m: "observe" | "edit") => {
    setMode(m);
    try { localStorage.setItem("wiw.mode", m); } catch {}
  };

  if (mode === "edit") {
    return (
      <div style={{ position: "relative", height: "100vh" }}>
        <div style={{ position: "fixed", top: 8, right: 12, zIndex: 1000 }}>
          <div className="mode-seg">
            <button onClick={() => switchTo("observe")}>관측</button>
            <button className="active">편집</button>
          </div>
        </div>
        <EditorApp />
      </div>
    );
  }

  return <ObservatoryShell onSwitchMode={() => switchTo("edit")} />;
}
