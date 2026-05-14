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
    return <EditorApp onSwitchMode={() => switchTo("observe")} />;
  }

  return <ObservatoryShell onSwitchMode={() => switchTo("edit")} />;
}
