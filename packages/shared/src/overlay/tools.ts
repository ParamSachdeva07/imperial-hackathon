/**
 * Overlay tool registry: names, model-facing descriptions (spec §4.1) and JSON Schema export
 * for function-calling definitions.
 *
 * Model-facing schemas omit `turnId` (the controller fills it). `cue` is only exposed when
 * stretch tools are enabled (speech-synced cues are a stretch feature).
 */
import { z } from "zod";
import {
  AdvanceStepInput,
  ClearInput,
  HighlightInput,
  MagnifyInput,
  PointAtInput,
  PreviewActionInput,
  ReplayLastInput,
  ShowExplainerInput,
  ShowStepsInput,
} from "./schemas";

export const MVP_TOOL_NAMES = ["point_at", "highlight", "show_steps", "advance_step", "show_explainer", "clear"] as const;
export const STRETCH_TOOL_NAMES = ["magnify", "preview_action", "replay_last"] as const;
export const TOOL_NAMES = [...MVP_TOOL_NAMES, ...STRETCH_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const ToolNameSchema = z.enum(TOOL_NAMES);

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: ToolName;
  /** What the model reads. These matter as much as the code. */
  description: string;
  input: S;
  /** `mvp` tools ship first; `stretch` tools are §2.2. */
  tier: "mvp" | "stretch";
  /** `model`: offered to the AI. `controller`: only called by the session controller. */
  audience: "model" | "controller";
}

export const TOOLS = {
  point_at: {
    name: "point_at",
    description:
      "Animate a large pointer onto one thing the user should click or look at. Use when telling the user *what to press next*. Prefer `kind: element` targets.",
    input: PointAtInput,
    tier: "mvp",
    audience: "model",
  },
  highlight: {
    name: "highlight",
    description:
      "Mark something on screen. `spotlight` dims everything else; use it when the user asks where something is. `underline` for text. Use `tone: warning` for anything risky (suspicious links, delete buttons). Only one highlight at a time; a new one replaces the old.",
    input: HighlightInput,
    tier: "mvp",
    audience: "model",
  },
  show_steps: {
    name: "show_steps",
    description:
      "Show a short numbered path (max 5) across real on-screen controls, for multi-step tasks. Only the current step is emphasised. When the user will do the steps over several turns, pass `expires: 'on_target_selected'`: the guide then stays across turns until its last step is done (or you call `clear`); move it on with `advance_step`.",
    input: ShowStepsInput,
    tier: "mvp",
    audience: "model",
  },
  advance_step: {
    name: "advance_step",
    description: "Move a step guide forward when the user has done the current step.",
    input: AdvanceStepInput,
    tier: "mvp",
    audience: "model",
  },
  show_explainer: {
    name: "show_explainer",
    description:
      "Show a picture card beside something on screen, only when a picture explains better than words. `anatomy` labels parts of the user's own screen; `sequence` shows a short how-to; `compare` shows two things side by side (put the safe/correct one on the LEFT — it gets ✓ bullets — and the risky one on the RIGHT — it gets ⚠ bullets); `concept` illustrates an idea. Never put words inside `imagePrompt`; captions carry all text.",
    input: ShowExplainerInput,
    tier: "mvp",
    audience: "model",
  },
  clear: {
    name: "clear",
    description: "Remove annotations. Call with `all` when the user says 'got it', 'okay' or changes topic.",
    input: ClearInput,
    tier: "mvp",
    audience: "model",
  },
  magnify: {
    name: "magnify",
    description:
      "Show a round magnifying lens (2x to 4x) over small text or a small icon so the user can read it. Use when something is too small to see.",
    input: MagnifyInput,
    tier: "stretch",
    audience: "model",
  },
  preview_action: {
    name: "preview_action",
    description:
      "Show a dashed ghost outline on the control you are about to use, with 'I'm about to <action> this. OK?'. Called before risky actions; removed when the action runs or is cancelled.",
    input: PreviewActionInput,
    tier: "stretch",
    audience: "controller",
  },
  replay_last: {
    name: "replay_last",
    description: "Show the most recent set of on-screen annotations again, when the user asks to see it again.",
    input: ReplayLastInput,
    tier: "stretch",
    audience: "model",
  },
} as const satisfies Record<ToolName, ToolDefinition>;

/** Function-calling definition in the OpenAI Realtime / Responses `function` tool shape. */
export interface FunctionToolDefinition {
  type: "function";
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ExportOptions {
  /** Include stretch tools and the `cue` field (default false). */
  includeStretch?: boolean;
  /**
   * imagePrompts that already have pre-generated images (assets/explainers/manifest.json). They are
   * listed in show_explainer's description so the model reuses them verbatim: instant, offline images.
   */
  pregeneratedImagePrompts?: string[];
  /** Include controller-only tools such as `preview_action` (default false). */
  includeControllerTools?: boolean;
}

const CONTROLLER_FILLED_FIELDS = ["turnId"] as const;
const STRETCH_FIELDS = ["cue"] as const;

/** Returns the zod schema the model sees for a tool (controller-filled fields removed). */
export function modelInputSchema(name: ToolName, opts: ExportOptions = {}): z.ZodObject {
  const schema: z.ZodObject = TOOLS[name].input;
  const drop = new Set<string>(CONTROLLER_FILLED_FIELDS);
  if (!opts.includeStretch) for (const f of STRETCH_FIELDS) drop.add(f);
  const mask: Record<string, true> = {};
  for (const key of Object.keys(schema.shape)) if (drop.has(key)) mask[key] = true;
  return Object.keys(mask).length ? schema.omit(mask) : schema;
}

/**
 * Normalise zod's JSON Schema for function calling:
 * - `oneOf` → `anyOf` (OpenAI strict mode only accepts anyOf; our unions are discriminated by a
 *   `kind`/`type` const, so the two are equivalent here),
 * - drop the ±MAX_SAFE_INTEGER bounds zod adds to `.int()` (noise for the model).
 */
export function normalizeForFunctionCalling(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeForFunctionCalling);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if ((key === "minimum" && value === Number.MIN_SAFE_INTEGER) || (key === "maximum" && value === Number.MAX_SAFE_INTEGER)) {
      continue;
    }
    out[key === "oneOf" ? "anyOf" : key] = normalizeForFunctionCalling(value);
  }
  return out;
}

export function toolJsonSchema(name: ToolName, opts: ExportOptions = {}): Record<string, unknown> {
  const json = z.toJSONSchema(modelInputSchema(name, opts), {
    io: "input",
    reused: "inline",
    target: "draft-2020-12",
  });
  return normalizeForFunctionCalling(json) as Record<string, unknown>;
}

/** The tool list to register with the voice model. */
export function exportToolDefinitions(opts: ExportOptions = {}): FunctionToolDefinition[] {
  return Object.values(TOOLS)
    .filter((t) => opts.includeStretch || t.tier === "mvp")
    .filter((t) => opts.includeControllerTools || t.audience === "model")
    .map((t) => ({
      type: "function" as const,
      name: t.name,
      description:
        t.name === "show_explainer" && opts.pregeneratedImagePrompts?.length
          ? `${t.description} These pictures are ready instantly; reuse one of these imagePrompts word for word when it fits: ${opts.pregeneratedImagePrompts.map((p) => JSON.stringify(p)).join("; ")}.`
          : t.description,
      parameters: toolJsonSchema(t.name, opts),
    }));
}

/** Validate a tool call's input against its full (controller-side) schema. */
export function parseToolInput(name: string, input: unknown) {
  const parsedName = ToolNameSchema.safeParse(name);
  if (!parsedName.success) return { success: false as const, error: `unknown tool: ${name}` };
  const result = TOOLS[parsedName.data].input.safeParse(input);
  if (!result.success) return { success: false as const, error: z.prettifyError(result.error) };
  return { success: true as const, name: parsedName.data, data: result.data };
}
