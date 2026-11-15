import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportToolDefinitions, MVP_TOOL_NAMES, parseToolInput, TOOLS, toolJsonSchema } from "./tools";

describe("show_explainer pictures switch", () => {
  const desc = (opts?: Parameters<typeof exportToolDefinitions>[0]) => exportToolDefinitions(opts).find((t) => t.name === "show_explainer")?.description ?? "";
  it("images: false says pictures are off and prefers verdict/sequence/anatomy/label_parts; the schema is unchanged", () => {
    const off = desc({ images: false, pregeneratedImagePrompts: ["a cat"] });
    expect(off).toContain("Pictures are off");
    expect(off).toContain("label_parts");
    expect(off).not.toContain("a cat"); // never advertises pregenerated prompts
    const a = exportToolDefinitions({ images: false }).find((t) => t.name === "show_explainer")?.parameters;
    const b = exportToolDefinitions().find((t) => t.name === "show_explainer")?.parameters;
    expect(a).toEqual(b);
  });
  it("default and images: true keep the base description (plus pregenerated prompts when given)", () => {
    expect(desc()).not.toContain("Pictures are off");
    expect(desc({ images: true, pregeneratedImagePrompts: ["a cat"] })).toContain('"a cat"');
  });
});

describe("tool registry", () => {
  it("offers move_avatar to the model as an MVP tool", () => {
    expect(TOOLS.move_avatar).toMatchObject({ tier: "mvp", audience: "model" });
    expect(MVP_TOOL_NAMES).toContain("move_avatar");
    const schema = toolJsonSchema("move_avatar") as { properties: Record<string, { default?: unknown }>; required?: string[] };
    expect(schema.properties.position?.default).toBe("auto");
    expect(schema.required ?? []).toEqual([]);
    expect(JSON.stringify(schema)).not.toContain("turnId");
  });

  it("offers label_parts to the model as an MVP tool with 1-5 items and no turnId", () => {
    expect(TOOLS.label_parts).toMatchObject({ tier: "mvp", audience: "model" });
    expect(MVP_TOOL_NAMES).toContain("label_parts");
    const schema = toolJsonSchema("label_parts") as { properties: { items: { minItems: number; maxItems: number } }; required: string[] };
    expect(schema.properties.items).toMatchObject({ minItems: 1, maxItems: 5 });
    expect(schema.required).toEqual(["items"]);
    expect(JSON.stringify(schema)).not.toContain("turnId");
    expect(TOOLS.label_parts.description).toMatch(/several|SEVERAL/);
    expect(TOOLS.show_explainer.description).toContain("verdict");
    expect(parseToolInput("label_parts", { items: [{ target: { kind: "element", elementId: "a" }, label: "x" }] }).success).toBe(true);
  });

  it("exports the MVP tools by default", () => {
    expect(exportToolDefinitions().map((t) => t.name)).toEqual([...MVP_TOOL_NAMES]);
  });

  it("adds stretch model tools on request but keeps controller-only tools out", () => {
    const names = exportToolDefinitions({ includeStretch: true }).map((t) => t.name);
    expect(names).toContain("magnify");
    expect(names).toContain("replay_last");
    expect(names).not.toContain("preview_action");
    expect(exportToolDefinitions({ includeStretch: true, includeControllerTools: true }).map((t) => t.name)).toContain(
      "preview_action",
    );
  });

  it("uses the spec's model-facing descriptions", () => {
    expect(TOOLS.clear.description).toBe("Remove annotations. Call with `all` when the user says 'got it', 'okay' or changes topic.");
    expect(TOOLS.point_at.description).toMatch(/Prefer `kind: element` targets/);
  });

  it("never exposes controller-filled turnId, and hides cue unless stretch is on", () => {
    const mvp = JSON.stringify(exportToolDefinitions());
    expect(mvp).not.toContain('"turnId"');
    expect(mvp).not.toContain('"cue"');
    const stretch = JSON.stringify(exportToolDefinitions({ includeStretch: true }));
    expect(stretch).not.toContain('"turnId"');
    expect(stretch).toContain('"cue"');
  });

  it("emits function-calling friendly JSON Schema (object root, anyOf, no $schema, no safe-int noise)", () => {
    for (const def of exportToolDefinitions({ includeStretch: true })) {
      expect(def.parameters.type).toBe("object");
      const text = JSON.stringify(def.parameters);
      expect(text).not.toContain("oneOf");
      expect(text).not.toContain("$schema");
      expect(text).not.toContain(String(Number.MAX_SAFE_INTEGER));
    }
    const highlight = toolJsonSchema("highlight") as { properties: Record<string, { default?: unknown }>; required: string[] };
    expect(highlight.properties.style?.default).toBe("ring");
    expect(highlight.required).toEqual(["target"]); // defaults make style/tone optional for the model
  });

  it("generated JSON is up to date (run `npm run gen:tools`)", () => {
    const file = join(__dirname, "..", "..", "generated", "overlay-tools.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(exportToolDefinitions())));
  });
});

describe("parseToolInput", () => {
  it("rejects unknown tools and invalid input with a readable error", () => {
    expect(parseToolInput("draw_cat", {})).toMatchObject({ success: false });
    const bad = parseToolInput("highlight", { target: { kind: "element" } });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error).toMatch(/elementId/);
  });
  it("returns parsed data with defaults applied", () => {
    const ok = parseToolInput("highlight", { target: { kind: "element", elementId: "a" } });
    expect(ok.success && ok.data).toMatchObject({ style: "ring", tone: "info" });
  });
});

describe("pre-generated image prompts", () => {
  it("are listed in show_explainer's description only when given", () => {
    const plain = exportToolDefinitions().find((t) => t.name === "show_explainer")!;
    expect(plain.description).not.toContain("ready instantly");
    const withImages = exportToolDefinitions({ pregeneratedImagePrompts: ["a red umbrella"] }).find((t) => t.name === "show_explainer")!;
    expect(withImages.description).toContain('"a red umbrella"');
  });
});
