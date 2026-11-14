import type { ReactNode } from "react";
import type { FakeTarget } from "./scenes";

/** Fake macOS-ish desktop (light or dark) with fake buttons where the scene's targets are. */
export function Desktop({ bg, targets, children }: { bg: "light" | "dark"; targets: FakeTarget[]; children?: ReactNode }) {
  return (
    <div className={`desktop desktop-${bg}`}>
      <div className="menubar">
        <span></span>
        <b>Mail</b>
        <span>File</span>
        <span>Edit</span>
        <span>View</span>
      </div>
      <div className="fake-window">
        <div className="fake-titlebar">
          <i style={{ background: "#ef4444" }} />
          <i style={{ background: "#f59e0b" }} />
          <i style={{ background: "#22c55e" }} />
        </div>
        <div className="fake-lines">
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} style={{ width: `${40 + ((i * 37) % 50)}%` }} />
          ))}
        </div>
      </div>
      {targets.map((t, i) => (
        <div key={i} className="fake-btn" style={{ left: t.rect.x, top: t.rect.y, width: t.rect.width, height: t.rect.height }}>
          {t.text}
        </div>
      ))}
      {children}
    </div>
  );
}
