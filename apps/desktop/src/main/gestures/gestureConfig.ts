/**
 * Env tunables for the gesture service (pure). The package's own launcher honours POINTY_GESTURES_ZONE;
 * the app passes it (and a few thresholds) through `startGestureService({ config })`, the public API.
 */
import type { GestureConfig } from "@pointy/gestures";

export interface ParsedGestureConfig {
  config: Partial<GestureConfig>;
  /** One line per applied override, for the startup log. */
  applied: string[];
  /** One line per ignored (invalid) value. */
  warnings: string[];
}

const NUMERIC: { env: string; key: "poseStableMs" | "fingerExtendRatio" | "scrollGain" | "scrollDeadzone" | "cursorDeadband"; min: number; max: number }[] = [
  { env: "POINTY_GESTURES_POSE_STABLE_MS", key: "poseStableMs", min: 0, max: 2000 },
  { env: "POINTY_GESTURES_FINGER_EXTEND_RATIO", key: "fingerExtendRatio", min: 0.5, max: 2 },
  { env: "POINTY_GESTURES_SCROLL_GAIN", key: "scrollGain", min: 0.1, max: 20 },
  { env: "POINTY_GESTURES_SCROLL_DEADZONE", key: "scrollDeadzone", min: 0, max: 100 },
  { env: "POINTY_GESTURES_DEADBAND", key: "cursorDeadband", min: 0, max: 100 },
];

export function parseGestureConfig(env: NodeJS.ProcessEnv): ParsedGestureConfig {
  const config: Partial<GestureConfig> = {};
  const applied: string[] = [];
  const warnings: string[] = [];

  const zone = env.POINTY_GESTURES_ZONE;
  if (zone) {
    const n = zone.split(",").map((v) => Number(v.trim()));
    const [x0, y0, x1, y1] = n;
    if (n.length === 4 && n.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) && x1! - x0! >= 0.1 && y1! - y0! >= 0.1) {
      config.activeZone = { x0: x0!, y0: y0!, x1: x1!, y1: y1! };
      applied.push(`zone=${n.join(",")}`);
    } else {
      warnings.push(`ignoring POINTY_GESTURES_ZONE="${zone}" (expected x0,y0,x1,y1 between 0 and 1, at least 0.1 apart, e.g. 0.15,0.2,0.85,0.7)`);
    }
  }
  for (const { env: name, key, min, max } of NUMERIC) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v >= min && v <= max) {
      config[key] = v;
      applied.push(`${key}=${v}`);
    } else {
      warnings.push(`ignoring ${name}="${raw}" (expected a number between ${min} and ${max})`);
    }
  }
  return { config, applied, warnings };
}
