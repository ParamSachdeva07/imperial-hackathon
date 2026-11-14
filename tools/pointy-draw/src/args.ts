/**
 * Pure argument parsing for pointy-draw (spec §8.1). Turns argv into a request for the dev server.
 */
import { parseArgs } from "node:util";

export type Request =
  | { kind: "tool"; name: string; input: Record<string, unknown> }
  | { kind: "control"; body: { op: string; arg?: string } }
  | { kind: "sim"; body: Record<string, unknown> }
  | { kind: "get"; path: "/events" | "/state" | "/displays" | "/elements" };

export interface ParseContext {
  primaryDisplayId: string;
  readJsonFile: (path: string) => unknown;
}

export class UsageError extends Error {}

export const USAGE = `pointy-draw — drive the Pointy overlay through the dev server

  pointy-draw highlight <target> [--style ring|spotlight|underline] [--tone info|warning|success] [--label TEXT] [--expires E]
  pointy-draw point <target> [--motion tap|double_tap|drag_to] [--drag-to-element ID | --drag-to-rect x,y,w,h] [--label TEXT] [--expires E]
  pointy-draw steps ID:"Label" ID:"Label" ... [--start-at N] [--expires E]
  pointy-draw advance STEPS_ID
  pointy-draw explainer --file PATH.json
  pointy-draw clear all|OVERLAY_ID
  pointy-draw tool NAME --json '{...}'          raw tool call
  pointy-draw sim move ELEMENT_ID dx,dy | sim remove ELEMENT_ID | sim restore [ELEMENT_ID]
  pointy-draw turn TURN_ID | context | select ELEMENT_ID | cue CUE_ID
  pointy-draw events | state | displays | elements

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
    const [x, y, width, height] = nums(get("rect")!, 4, "--rect");
    return { kind: "rect", displayId, rect: { x, y, width, height } };
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

export function parseCommand(argv: string[], ctx: ParseContext): Request {
  const { values: v, positionals: pos } = parseArgs({
    args: argv,
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
      expires: { type: "string" },
      motion: { type: "string" },
      "drag-to-element": { type: "string" },
      "drag-to-rect": { type: "string" },
      "drag-to-point": { type: "string" },
      "start-at": { type: "string" },
      file: { type: "string" },
      json: { type: "string" },
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
    case "advance":
      if (!rest[0]) throw new UsageError("advance: give a steps id");
      return { kind: "tool", name: "advance_step", input: { stepsId: rest[0] } };
    case "explainer":
      if (!v.file) throw new UsageError("explainer: --file PATH.json is required");
      return { kind: "tool", name: "show_explainer", input: ctx.readJsonFile(v.file as string) as Record<string, unknown> };
    case "clear":
      return { kind: "tool", name: "clear", input: { overlayId: rest[0] ?? "all" } };
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
