/**
 * Pure argument parsing for pointy-draw (spec §8.1). Turns argv into a request for the dev server.
 */
import { parseArgs } from "node:util";
import { parseRect } from "@pointy/shared/overlay/geometry";
import { circleEvents, clickEvents, dwellEvents, FRAME_MS, lostEvents, mouseEvents, pointEvents, scrollEvents, wakeEvents } from "./gesture";

export type Request =
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "control"; body: { op: string; arg?: string } }
  | { kind: "sim"; body: Record<string, unknown> }
  | { kind: "selection"; outDir: string }
  | { kind: "get"; path: "/events" | "/state" | "/displays" | "/elements" }
  | { kind: "post"; path: "/fixture"; body: Record<string, unknown> }
  | { kind: "post"; path: "/gesture"; body: { events: unknown[]; intervalMs: number } }
  | { kind: "post"; path: "/gesture/session"; body: { active: boolean } };

export interface ParseContext {
  primaryDisplayId: string;
  readJsonFile: (path: string) => unknown;
}

export const DEFAULT_SELECTION_DIR = "artifacts/selection";

export class UsageError extends Error {}

export const USAGE = `pointy-draw — drive the Pointy overlay through the dev server

  pointy-draw highlight <target> [--style ring|spotlight|underline] [--tone info|warning|success] [--label TEXT] [--expires E]
  pointy-draw point <target> [--motion tap|double_tap|drag_to] [--drag-to-element ID | --drag-to-rect x,y,w,h] [--label TEXT] [--expires E]
  pointy-draw steps ID:"Label" ID:"Label" ... [--start-at N] [--expires E]
  pointy-draw label-parts ID:"Label" ID:"Label" ... [--tone info|warning|success] [--title TEXT] [--expires E]   ring + label on each part (one drawing)
  pointy-draw label-parts --file PATH.json      full label_parts input (see examples/label-parts-scam.json)
  pointy-draw advance STEPS_ID
  pointy-draw explainer --file PATH.json
  pointy-draw clear all|OVERLAY_ID
  pointy-draw move-avatar [auto|top_left|top_right|bottom_left|bottom_right] [<target>]   move the voice avatar window
  pointy-draw tool NAME --json '{...}'          raw tool call
  pointy-draw sim move ELEMENT_ID dx,dy | sim remove ELEMENT_ID | sim restore [ELEMENT_ID]
  pointy-draw turn TURN_ID | context | select ELEMENT_ID | cue CUE_ID
  pointy-draw events | state | displays | elements
  pointy-draw gesture circle --center x,y --radius R [--ms 1500]   simulate a circled region (cursor, dwell, region_selected)
  pointy-draw gesture dwell x,y [--ms 800] | gesture point x,y | gesture lost
  pointy-draw gesture wake x,y [--ms 700]     simulate a raised open palm held still (wake ring, then wake_requested)
  pointy-draw gesture mouse x,y | gesture click x,y [--ms 800] | gesture scroll [--dy 300]   one finger / dwell click / fist drag (dy>0 scrolls up).
                                              These reach the REAL OS mouse only if the app runs with POINTY_GESTURES_MOUSE=1 and the session is on
  pointy-draw gesture session on|off          open/close the gesture session (feedback only shows while on)
  pointy-draw selection [--out DIR]           fetch the latest gesture selection (default DIR artifacts/selection): writes full.jpg, focus.jpg, selection.json
  pointy-draw fixture                         open (or bring back) the fake mail test app

  gesture coordinates are display-relative DIP on the primary display (or --display ID, numeric).
  <target>: --element ID | --rect x,y,w,h | --point x,y | --polygon "x,y x,y x,y"  [--display ID (default: primary)]
  E (expiry): next_turn | on_target_selected | context_change | manual | <milliseconds>
  --wait-shown   wait for overlay.shown and print the latency (tool calls)`;

const nums = (s: string, n: number, what: string): number[] => {
  const parts = s.split(",").map((p) => Number(p.trim()));
  if (parts.length !== n || parts.some((p) => !Number.isFinite(p))) throw new UsageError(`${what}: expected ${n} comma-separated numbers, got "${s}"`);
  return parts;
};

type Values = Record<string, string | boolean | undefined>;

function target(v: Values, ctx: ParseContext, prefix = ""): Record<string, unknown> {
  const get = (k: string) => v[prefix + k] as string | undefined;
  const displayId = (v.display as string | undefined) ?? ctx.primaryDisplayId;
  if (get("element")) return { kind: "element", elementId: get("element") };
  if (get("rect")) {
    const rect = parseRect(get("rect")!);
    if (!rect) throw new UsageError(`--${prefix}rect: expected x,y,w,h with w,h > 0, got "${get("rect")}"`);
    return { kind: "rect", displayId, rect };
  }
  if (get("point")) {
    const [x, y] = nums(get("point")!, 2, "--point");
    return { kind: "point", displayId, point: { x, y } };
  }
  if (get("polygon")) {
    const points = get("polygon")!
      .trim()
      .split(/\s+/)
      .map((p) => {
        const [x, y] = nums(p, 2, "--polygon point");
        return { x, y };
      });
    return { kind: "polygon", displayId, points };
  }
  throw new UsageError(`missing target: use --${prefix}element, --${prefix}rect, --${prefix}point or --${prefix}polygon`);
}

function expiry(v: Values): Record<string, unknown> {
  const e = v.expires as string | undefined;
  if (!e) return {};
  return /^\d+$/.test(e) ? { expires: { ms: Number(e) } } : { expires: e };
}

const optional = (key: string, value: unknown): Record<string, unknown> => (value === undefined ? {} : { [key]: value });

/** parseArgs reads "--dy -300" as an option; turn it into "--dy=-300". */
function joinNegativeDy(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--dy" && next !== undefined && /^-\d/.test(next)) {
      out.push(`--dy=${next}`);
      i++;
    } else out.push(argv[i] as string);
  }
  return out;
}

export function parseCommand(argv: string[], ctx: ParseContext): Request {
  const { values: v, positionals: pos } = parseArgs({
    args: joinNegativeDy(argv),
    allowPositionals: true,
    options: {
      element: { type: "string" },
      rect: { type: "string" },
      point: { type: "string" },
      polygon: { type: "string" },
      display: { type: "string" },
      style: { type: "string" },
      tone: { type: "string" },
      label: { type: "string" },
      title: { type: "string" },
      expires: { type: "string" },
      motion: { type: "string" },
      "drag-to-element": { type: "string" },
      "drag-to-rect": { type: "string" },
      "drag-to-point": { type: "string" },
      "start-at": { type: "string" },
      file: { type: "string" },
      json: { type: "string" },
      center: { type: "string" },
      radius: { type: "string" },
      ms: { type: "string" },
      dy: { type: "string" },
      out: { type: "string" },
      "wait-shown": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = pos;
  if (!cmd || v.help) throw new UsageError(USAGE);

  switch (cmd) {
    case "highlight":
      return {
        kind: "tool",
        name: "highlight",
        input: { target: target(v, ctx), ...optional("style", v.style), ...optional("tone", v.tone), ...optional("label", v.label), ...expiry(v) },
      };
    case "point": {
      const hasDrag = v["drag-to-element"] || v["drag-to-rect"] || v["drag-to-point"];
      return {
        kind: "tool",
        name: "point_at",
        input: {
          target: target(v, ctx),
          ...optional("motion", v.motion ?? (hasDrag ? "drag_to" : undefined)),
          ...(hasDrag ? { dragTo: target(v, ctx, "drag-to-") } : {}),
          ...optional("label", v.label),
          ...expiry(v),
        },
      };
    }
    case "steps": {
      if (rest.length === 0) throw new UsageError('steps: give at least one ID:"Label"');
      const steps = rest.map((s) => {
        const i = s.indexOf(":");
        if (i <= 0) throw new UsageError(`steps: expected ID:"Label", got "${s}"`);
        return { target: { kind: "element", elementId: s.slice(0, i) }, label: s.slice(i + 1) };
      });
      return {
        kind: "tool",
        name: "show_steps",
        input: { steps, ...optional("startAt", v["start-at"] === undefined ? undefined : Number(v["start-at"])), ...expiry(v) },
      };
    }
    case "label-parts": {
      if (v.file) return { kind: "tool", name: "label_parts", input: ctx.readJsonFile(v.file as string) as Record<string, unknown> };
      if (v.json) return { kind: "tool", name: "label_parts", input: JSON.parse(v.json as string) as Record<string, unknown> };
      if (rest.length === 0) throw new UsageError('label-parts: give ID:"Label" pairs, or --file PATH.json / --json \'{...}\'');
      const items = rest.map((s) => {
        const i = s.indexOf(":");
        if (i <= 0) throw new UsageError(`label-parts: expected ID:"Label", got "${s}"`);
        return { target: { kind: "element", elementId: s.slice(0, i) }, label: s.slice(i + 1), ...optional("tone", v.tone) };
      });
      return { kind: "tool", name: "label_parts", input: { items, ...optional("title", v.title), ...expiry(v) } };
    }
    case "advance":
      if (!rest[0]) throw new UsageError("advance: give a steps id");
      return { kind: "tool", name: "advance_step", input: { stepsId: rest[0] } };
    case "explainer":
      if (!v.file) throw new UsageError("explainer: --file PATH.json is required");
      return { kind: "tool", name: "show_explainer", input: ctx.readJsonFile(v.file as string) as Record<string, unknown> };
    case "clear":
      return { kind: "tool", name: "clear", input: { overlayId: rest[0] ?? "all" } };
    case "move-avatar": {
      const hasAvoid = v.element || v.rect || v.point || v.polygon;
      return {
        kind: "tool",
        name: "move_avatar",
        input: { ...(rest[0] ? { position: rest[0].replace(/-/g, "_") } : {}), ...(hasAvoid ? { avoid: target(v, ctx) } : {}) },
      };
    }
    case "tool":
      if (!rest[0]) throw new UsageError("tool: give a tool name");
      return { kind: "tool", name: rest[0], input: v.json ? (JSON.parse(v.json as string) as Record<string, unknown>) : {} };
    case "sim": {
      const [op, id, delta] = rest;
      if (op === "move") {
        if (!id || !delta) throw new UsageError("sim move ELEMENT_ID dx,dy");
        const [dx, dy] = nums(delta, 2, "sim move");
        return { kind: "sim", body: { op: "move", elementId: id, dx, dy } };
      }
      if (op === "remove") {
        if (!id) throw new UsageError("sim remove ELEMENT_ID");
        return { kind: "sim", body: { op: "remove", elementId: id } };
      }
      if (op === "restore") return { kind: "sim", body: { op: "restore", ...optional("elementId", id) } };
      throw new UsageError("sim: move | remove | restore");
    }
    case "turn":
      return { kind: "control", body: { op: "turnStart", arg: rest[0] ?? `turn-${Date.now()}` } };
    case "context":
      return { kind: "control", body: { op: "contextChange" } };
    case "select":
      if (!rest[0]) throw new UsageError("select ELEMENT_ID");
      return { kind: "control", body: { op: "targetSelected", arg: rest[0] } };
    case "cue":
      if (!rest[0]) throw new UsageError("cue CUE_ID");
      return { kind: "control", body: { op: "cue", arg: rest[0] } };
    case "gesture":
      return gestureCommand(rest, v, ctx);
    case "selection":
      return { kind: "selection", outDir: (v.out as string | undefined) ?? DEFAULT_SELECTION_DIR };
    case "fixture":
      return { kind: "post", path: "/fixture", body: {} };
    case "events":
    case "state":
    case "displays":
    case "elements":
      return { kind: "get", path: `/${cmd}` };
  }
  throw new UsageError(`unknown command "${cmd}"\n\n${USAGE}`);
}

export function wantsWaitShown(argv: string[]): boolean {
  return argv.includes("--wait-shown");
}

function gestureCommand(rest: string[], v: Values, ctx: ParseContext): Request {
  const [sub, arg] = rest;
  const displayId = Number((v.display as string | undefined) ?? ctx.primaryDisplayId);
  if (!Number.isInteger(displayId)) throw new UsageError(`gesture: display id must be numeric, got "${String(v.display ?? ctx.primaryDisplayId)}"`);
  const ms = (fallback: number): number => {
    if (v.ms === undefined) return fallback;
    const n = Number(v.ms);
    if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--ms: expected a positive number, got "${String(v.ms)}"`);
    return n;
  };
  const post = (events: unknown[]): Request => ({ kind: "post", path: "/gesture", body: { events, intervalMs: FRAME_MS } });
  const xy = (what: string): { x: number; y: number } => {
    if (!arg) throw new UsageError(`${what}: give x,y`);
    const [x, y] = nums(arg, 2, what);
    return { x: x as number, y: y as number };
  };
  switch (sub) {
    case "circle": {
      if (!v.center || !v.radius) throw new UsageError("gesture circle: --center x,y and --radius R are required");
      const [x, y] = nums(v.center as string, 2, "--center");
      const radius = Number(v.radius);
      if (!Number.isFinite(radius) || radius <= 0) throw new UsageError(`--radius: expected a positive number, got "${String(v.radius)}"`);
      return post(circleEvents({ x: x as number, y: y as number }, radius, displayId, ms(1500)));
    }
    case "dwell":
      return post(dwellEvents(xy("gesture dwell"), displayId, ms(800)));
    case "wake":
      return post(wakeEvents(xy("gesture wake"), displayId, ms(700)));
    case "point":
      return post(pointEvents(xy("gesture point"), displayId));
    case "lost":
      return post(lostEvents());
    case "mouse":
      return post(mouseEvents(xy("gesture mouse"), displayId));
    case "click":
      return post(clickEvents(xy("gesture click"), displayId, ms(800)));
    case "scroll": {
      const dy = v.dy === undefined ? 300 : Number(v.dy);
      if (!Number.isFinite(dy) || dy === 0) throw new UsageError(`--dy: expected a non-zero number, got "${String(v.dy)}"`);
      return post(scrollEvents(dy, ms(600)));
    }
    case "session":
      if (arg !== "on" && arg !== "off") throw new UsageError("gesture session on|off");
      return { kind: "post", path: "/gesture/session", body: { active: arg === "on" } };
  }
  throw new UsageError("gesture: circle | dwell | point | lost | wake | mouse | click | scroll | session");
}
