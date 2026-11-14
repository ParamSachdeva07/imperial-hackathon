/** Static RenderScenes covering every primitive, template and state (global DIP, one 1280x800 display). */
import type {
  AnatomyCallout,
  ExplainerBody,
  ExplainerItem,
  HighlightItem,
  ImageSlot,
  PointerItem,
  RenderLabel,
  RenderScene,
  RenderStep,
  RenderTarget,
  StepsItem,
} from "@pointy/shared/overlay/render";
import { measureCard, measureLabel } from "@pointy/shared/overlay/measure";
import type { ExplainerSpec, IconName, Point, Rect, Tone } from "@pointy/shared/overlay/schemas";

export const DISPLAY = { id: "display-1", bounds: { x: 0, y: 0, width: 1280, height: 800 }, scaleFactor: 2 };

/** A fake UI element drawn on the desktop under the overlay. */
export interface FakeTarget {
  rect: Rect;
  text: string;
}

export interface GalleryScene {
  name: string;
  title: string;
  targets: FakeTarget[];
  scene: RenderScene;
}

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const rt = (r: Rect): RenderTarget => ({ bounds: r, shape: { kind: "rect" } });
const centre = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

function label(text: string, x: number, y: number, tone?: Tone): RenderLabel {
  const { width, height } = measureLabel(text, tone !== undefined);
  return { text, rect: rect(x, y, width, height), ...(tone ? { tone } : {}), connector: null };
}

let seq = 0;
function scene(items: RenderScene["items"], reduceMotion = false): RenderScene {
  return { seq: ++seq, display: DISPLAY, reduceMotion, items };
}

function highlight(
  id: string,
  style: HighlightItem["style"],
  tone: Tone,
  target: RenderTarget,
  lbl: RenderLabel | null,
  state: HighlightItem["state"] = "visible",
): HighlightItem {
  return { id, kind: "highlight", state, style, tone, target, label: lbl };
}

// ---------- sample images (inline SVG data URLs; no external assets) ----------
const svgUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/** A fake screenshot crop (aspect 1.6) with a toolbar, a list and three buttons. */
export const SAMPLE_CROP = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
  <rect width="800" height="500" fill="#f3f4f6"/><rect width="800" height="64" fill="#d1d5db"/>
  <circle cx="36" cy="32" r="12" fill="#ef4444"/><circle cx="72" cy="32" r="12" fill="#f59e0b"/><circle cx="108" cy="32" r="12" fill="#22c55e"/>
  <rect x="40" y="110" width="440" height="60" rx="10" fill="#fff" stroke="#9ca3af" stroke-width="3"/>
  <rect x="40" y="200" width="440" height="40" rx="8" fill="#e5e7eb"/><rect x="40" y="260" width="360" height="40" rx="8" fill="#e5e7eb"/>
  <rect x="40" y="330" width="170" height="70" rx="12" fill="#2563eb"/><rect x="230" y="330" width="170" height="70" rx="12" fill="#9ca3af"/>
  <rect x="560" y="110" width="200" height="290" rx="12" fill="#fff" stroke="#9ca3af" stroke-width="3"/></svg>`,
);
const SAMPLE_PICTURE = svgUrl(
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="#bfdbfe"/><circle cx="310" cy="70" r="42" fill="#fde68a"/>
  <path d="M0 230 Q100 150 200 220 T400 200 V300 H0z" fill="#86efac"/><rect x="150" y="150" width="100" height="80" fill="#fff" stroke="#6b7280" stroke-width="4"/>
  <path d="M140 150 L200 100 L260 150z" fill="#f87171"/></svg>`,
);

const ready: ImageSlot = { status: "ready", src: SAMPLE_PICTURE };
const loading = (fallbackIcon: IconName): ImageSlot => ({ status: "loading", fallbackIcon });
const failed = (fallbackIcon: IconName): ImageSlot => ({ status: "failed", fallbackIcon });

// ---------- explainer helpers ----------
const anyTarget = { kind: "point" as const, displayId: "display-1", point: { x: 0, y: 0 } };

function explainer(
  id: string,
  title: string,
  body: ExplainerBody,
  spec: ExplainerSpec,
  at: { x: number; y: number },
  opts: { scale?: number; anchor?: RenderTarget; state?: ExplainerItem["state"]; imageScale?: number } = {},
): ExplainerItem {
  const imageScale = opts.imageScale ?? 1;
  const designSize = measureCard(title, spec, imageScale);
  const scale = opts.scale ?? 1;
  const card = rect(at.x, at.y, designSize.width * scale, designSize.height * scale);
  const connector = opts.anchor
    ? { from: { x: card.x, y: card.y + Math.min(80, card.height / 2) }, to: { x: opts.anchor.bounds.x + opts.anchor.bounds.width + 4, y: centre(opts.anchor.bounds).y } }
    : null;
  return { id, kind: "explainer", state: opts.state ?? "visible", title, anchor: opts.anchor ?? null, designSize, imageScale, scale, card, connector, body };
}

const callout = (n: number, label: string, nx: number, ny: number, nw: number, nh: number, inside = true): AnatomyCallout => ({ n, label, nx, ny, nw, nh, inside });

const CALLOUTS = [
  callout(1, "Type the address here", 0.05, 0.22, 0.55, 0.12),
  callout(2, "Press Send when done", 0.05, 0.66, 0.21, 0.14),
  callout(3, "Your messages appear on this side", 0.7, 0.22, 0.25, 0.58),
];

const specSequence = (steps: { icon: IconName; caption: string }[]): ExplainerSpec => ({ kind: "sequence", steps });
const specAnatomy = (callouts: AnatomyCallout[]): ExplainerSpec => ({
  kind: "anatomy",
  region: anyTarget,
  callouts: callouts.map((c) => ({ target: anyTarget, label: c.label })),
});

const SEQ3 = [
  { icon: "folder" as const, caption: "Open your Documents folder" },
  { icon: "attach" as const, caption: "Click the paperclip" },
  { icon: "send" as const, caption: "Press Send" },
];
const SEQ5 = [
  { icon: "wifi" as const, caption: "Open Wi-Fi settings" },
  { icon: "lock" as const, caption: "Pick your home network" },
  { icon: "type" as const, caption: "Type the password carefully" },
  { icon: "check" as const, caption: "Wait for the tick" },
  { icon: "email" as const, caption: "Try your email again" },
];

// ---------- scene list ----------
const row3 = [rect(120, 300, 220, 72), rect(530, 300, 220, 72), rect(940, 300, 220, 72)];
const rowTargets = (texts: string[]): FakeTarget[] => row3.map((r, i) => ({ rect: r, text: texts[i] ?? "" }));
const TONES: Tone[] = ["info", "warning", "success"];
const LABEL_TEXTS = ["Click here to send", "This will delete it", "That worked!"];

function highlightRow(style: HighlightItem["style"], withLabel: boolean, only?: number): RenderScene {
  const idx = only === undefined ? [0, 1, 2] : [only];
  return scene(
    idx.map((i) => {
      const r = row3[i]!;
      const tone = TONES[i]!;
      return highlight(
        `${style}-${tone}`,
        style,
        tone,
        rt(r),
        withLabel ? label(LABEL_TEXTS[i]!, r.x, r.y + r.height + 30, tone) : null,
      );
    }),
  );
}

const ptrTarget = rect(570, 380, 220, 72);
function pointer(id: string, motion: PointerItem["motion"], over: Partial<PointerItem> = {}): PointerItem {
  const c = centre(ptrTarget);
  return {
    id,
    kind: "pointer",
    state: "visible",
    motion,
    target: rt(ptrTarget),
    dragTo: null,
    entry: { x: -110, y: c.y },
    tap: c,
    dragEnd: null,
    rest: { x: ptrTarget.x - 20, y: c.y },
    angle: 0,
    label: null,
    ...over,
  };
}

const stepRects = [rect(100, 500, 200, 64), rect(420, 380, 200, 64), rect(780, 280, 200, 64), rect(520, 620, 200, 64), rect(1000, 160, 200, 64)];
function step(i: number, status: RenderStep["status"], found: boolean, text: string): RenderStep {
  const r = stepRects[i]!;
  return {
    index: i,
    label: text,
    status,
    target: found ? rt(r) : null,
    badge: found ? { x: r.x - 20, y: r.y - 8 } : null,
    labelBox: status === "current" ? label(text, r.x, r.y + r.height + 28, "info") : null,
  };
}

export const SCENES: GalleryScene[] = [
  { name: "ring-labeled", title: "Ring + label (info / warning / success)", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("ring", true) },
  { name: "ring-glyph", title: "Ring without label (glyph badge)", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("ring", false) },
  { name: "underline-labeled", title: "Underline + label", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("underline", true) },
  { name: "underline-glyph", title: "Underline without label", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("underline", false) },
  { name: "spotlight-info-label", title: "Spotlight info + label", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("spotlight", true, 0) },
  { name: "spotlight-warning-glyph", title: "Spotlight warning, no label", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("spotlight", false, 1) },
  { name: "spotlight-success-label", title: "Spotlight success + label", targets: rowTargets(["Send", "Delete", "Done"]), scene: highlightRow("spotlight", true, 2) },
  {
    name: "ring-shapes",
    title: "Ring on polygon, point and wide rect",
    targets: [{ rect: rect(160, 300, 420, 90), text: "Wide search field" }, { rect: rect(900, 230, 160, 40), text: "" }],
    scene: scene([
      highlight("poly", "ring", "info", { bounds: rect(760, 300, 300, 200), shape: { kind: "polygon", points: [{ x: 780, y: 330 }, { x: 900, y: 300 }, { x: 1050, y: 360 }, { x: 1040, y: 470 }, { x: 880, y: 495 }, { x: 770, y: 440 }] } }, label("Circled area", 780, 530, "info")),
      highlight("point", "ring", "success", { bounds: rect(300, 520, 2, 2), shape: { kind: "point", point: { x: 300, y: 560 } } }, null),
      highlight("wide", "ring", "info", rt(rect(160, 300, 420, 90)), label("Type here", 160, 420, "info")),
    ]),
  },
  {
    name: "spotlight-polygon",
    title: "Spotlight on a polygon (true path)",
    targets: [],
    scene: scene([
      highlight("poly", "spotlight", "info", { bounds: rect(500, 250, 320, 250), shape: { kind: "polygon", points: [{ x: 520, y: 290 }, { x: 650, y: 255 }, { x: 800, y: 330 }, { x: 780, y: 470 }, { x: 600, y: 495 }, { x: 510, y: 420 }] } }, label("This photo", 520, 530, "info")),
    ]),
  },
  { name: "pointer-tap", title: "Pointer tap (from left)", targets: [{ rect: ptrTarget, text: "Open" }], scene: scene([pointer("p", "tap")]) },
  { name: "pointer-double-tap", title: "Pointer double tap", targets: [{ rect: ptrTarget, text: "Open" }], scene: scene([pointer("p", "double_tap")]) },
  {
    name: "pointer-drag",
    title: "Pointer drag_to",
    targets: [{ rect: rect(240, 380, 220, 72), text: "File" }, { rect: rect(900, 380, 220, 72), text: "Folder" }],
    scene: scene([
      pointer("p", "drag_to", {
        target: rt(rect(240, 380, 220, 72)),
        dragTo: rt(rect(900, 380, 220, 72)),
        tap: { x: 350, y: 416 },
        dragEnd: { x: 1010, y: 416 },
        rest: { x: 220, y: 416 },
      }),
    ]),
  },
  {
    name: "pointer-label",
    title: "Pointer with label",
    targets: [{ rect: ptrTarget, text: "Open" }],
    scene: scene([pointer("p", "tap", { label: label("Tap Open", 420, 470, "info") })]),
  },
  {
    name: "pointer-top",
    title: "Pointer entering from top",
    targets: [{ rect: ptrTarget, text: "Open" }],
    scene: scene([pointer("p", "tap", { entry: { x: 680, y: -110 }, angle: 90, rest: { x: 680, y: 360 } })]),
  },
  {
    name: "pointer-right",
    title: "Pointer entering from right",
    targets: [{ rect: ptrTarget, text: "Open" }],
    scene: scene([pointer("p", "tap", { entry: { x: 1390, y: 416 }, angle: 180, rest: { x: 810, y: 416 } })]),
  },
  {
    name: "pointer-bottom",
    title: "Pointer entering from bottom",
    targets: [{ rect: ptrTarget, text: "Open" }],
    scene: scene([pointer("p", "tap", { entry: { x: 680, y: 910 }, angle: 270, rest: { x: 680, y: 472 } })]),
  },
  {
    name: "steps",
    title: "Steps: past, current, future, not found",
    targets: stepRects.map((r, i) => ({ rect: r, text: ["Open menu", "Choose Share", "Pick a person", "(not found)", "Send"][i]! })).filter((_, i) => i !== 3),
    scene: scene([
      {
        id: "steps",
        kind: "steps",
        state: "visible",
        current: 1,
        completed: false,
        steps: [step(0, "past", true, "Open menu"), step(1, "current", true, "Choose Share"), step(2, "future", true, "Pick a person"), step(3, "future", false, "Hidden"), step(4, "future", true, "Send")],
      } satisfies StepsItem,
    ]),
  },
  {
    name: "explainer-sequence",
    title: "Explainer: sequence (3 steps)",
    targets: [{ rect: rect(300, 400, 200, 64), text: "Attach" }],
    scene: scene([explainer("e", "How to send a file", { kind: "sequence", steps: SEQ3 }, specSequence(SEQ3), { x: 700, y: 120 }, { anchor: rt(rect(300, 400, 200, 64)) })]),
  },
  {
    name: "explainer-sequence-5",
    title: "Explainer: sequence (5 steps)",
    targets: [],
    scene: scene([explainer("e", "Connect to Wi-Fi", { kind: "sequence", steps: SEQ5 }, specSequence(SEQ5), { x: 380, y: 100 })]),
  },
  {
    name: "explainer-compare",
    title: "Explainer: compare",
    targets: [],
    scene: (() => {
      const left = { title: "Safe email", points: ["From someone you know", "Matches the sender"] };
      const right = { title: "Scam email", points: ["Urgent money request", "Strange link"] };
      return scene([
        explainer("e", "Spot the difference", { kind: "compare", left: { ...left, image: null }, right: { ...right, image: null } }, { kind: "compare", left, right }, { x: 380, y: 160 }),
      ]);
    })(),
  },
  {
    name: "explainer-compare-images",
    title: "Explainer: compare with images",
    targets: [],
    scene: (() => {
      const left = { title: "Do this", points: ["Wait for the green tick", "Check the sender name"], imagePrompt: "x" };
      const right = { title: "Not this", points: ["Never share a code over the phone with a stranger"], imagePrompt: "y" };
      return scene([
        explainer(
          "e",
          "Staying safe online",
          { kind: "compare", left: { title: left.title, points: left.points, image: ready }, right: { title: right.title, points: right.points, image: loading("warning") } },
          { kind: "compare", left, right },
          { x: 380, y: 60 },
        ),
      ]);
    })(),
  },
  {
    name: "explainer-anatomy",
    title: "Explainer: anatomy (image + callouts)",
    targets: [],
    scene: scene([
      explainer("e", "Parts of the message window", { kind: "anatomy", image: { status: "ready", src: SAMPLE_CROP }, aspect: 1.6, callouts: CALLOUTS }, specAnatomy(CALLOUTS), { x: 380, y: 40 }),
    ]),
  },
  {
    name: "explainer-anatomy-legend-only",
    title: "Anatomy: loading image, one callout outside the crop",
    targets: [],
    scene: (() => {
      const c = [CALLOUTS[0]!, callout(2, "The Send button is below this view", 0, 0, 0, 0, false)];
      return scene([explainer("e", "Parts of the window", { kind: "anatomy", image: loading("photo"), aspect: 1.6, callouts: c }, specAnatomy(c), { x: 380, y: 100 })]);
    })(),
  },
  ...(["loading", "ready", "failed"] as const).map((status): GalleryScene => {
    const slots: ImageSlot[] =
      status === "loading" ? [loading("cloud"), loading("lock")] : status === "ready" ? [ready, ready] : [failed("cloud"), failed("lock")];
    const spec: ExplainerSpec = {
      kind: "concept",
      panels: [
        { caption: "Your photos live on a computer far away", imagePrompt: "a" },
        { caption: "A password keeps them private", imagePrompt: "b" },
      ],
    };
    return {
      name: `explainer-concept-${status}`,
      title: `Explainer: concept (${status}, scaled 0.8)`,
      targets: [],
      scene: scene([
        explainer(
          "e",
          "What is the cloud?",
          { kind: "concept", panels: spec.panels.map((p, i) => ({ caption: p.caption, image: slots[i]! })) },
          spec,
          { x: 380, y: 24 },
          { scale: 0.8 },
        ),
      ]),
    };
  }),
  {
    name: "reduce-motion",
    title: "reduceMotion: ring, pointer and card fade only",
    targets: [{ rect: rect(160, 300, 220, 72), text: "Send" }],
    scene: scene(
      [
        highlight("r", "ring", "info", rt(rect(160, 300, 220, 72)), label("Click Send", 160, 400, "info")),
        pointer("p", "tap", { target: rt(rect(160, 300, 220, 72)), tap: { x: 270, y: 336 }, rest: { x: 140, y: 336 }, entry: { x: -110, y: 336 } }),
        explainer("e", "How to send", { kind: "sequence", steps: SEQ3 }, specSequence(SEQ3), { x: 700, y: 120 }),
      ],
      true,
    ),
  },
  {
    name: "exiting",
    title: "Exiting item fading out beside a visible one",
    targets: rowTargets(["Send", "Delete", "Done"]),
    scene: scene([
      highlight("a", "ring", "info", rt(row3[0]!), label("Click here to send", row3[0]!.x, 402, "info")),
      highlight("b", "ring", "warning", rt(row3[1]!), label("This will delete it", row3[1]!.x, 402, "warning"), "exiting"),
    ]),
  },
];

// ---------- check-only scenes: stress the measure.ts estimates with realistic text ----------
const LABEL_SAMPLES = [
  "OK",
  "Send",
  "Click Send",
  "Open the Settings app",
  "Type your name here",
  "Press the green button",
  "Careful, this deletes it",
  "Your files are saved",
  "Choose the second picture on the left",
  "This is a very long caption that really will need to wrap around",
  "Supercalifragilisticexpialidocious_unbreakable_word_here",
  "Wi-Fi password: ask a family member for the code",
  "WWWWWWWWWWWWWW MMMMMMMMMMMMM",
  "iiiiiiiiiiii llllllllll jjjjjjjj",
  "Welcome back, Margaret",
  "Step 3: select Print",
  "Save as PDF",
  "Do not close this window yet please",
  "Tap the envelope",
  "1234567890 1234567890 1234567890",
  "Hello, press here and then wait",
  "Look at the top right corner",
  "Enter the 6 digit code",
  "A",
  "Click the small gear icon at the top",
];

function checkLabels(withGlyph: boolean): RenderScene {
  let y = 10;
  let x = 10;
  const items: HighlightItem[] = [];
  LABEL_SAMPLES.forEach((text, i) => {
    const l = label(text, x, y, withGlyph ? TONES[i % 3]! : undefined);
    if (x + l.rect.width > 1260) {
      x = 10;
      y += 110;
      l.rect = { ...l.rect, x, y };
    }
    x += l.rect.width + 16;
    y = Math.max(y, l.rect.y);
    items.push(highlight(`l${i}`, "ring", "info", rt(rect(0, 0, 4, 4)), l));
  });
  return scene(items);
}

const LONG = "Click the button at the very top of the window right now";
const CHECK_SPECS: { name: string; title: string; body: ExplainerBody; spec: ExplainerSpec }[] = [
  { name: "seq-long", title: "A rather long title that definitely wraps over two lines", body: { kind: "sequence", steps: SEQ5.map((s) => ({ ...s, caption: LONG })) }, spec: specSequence(SEQ5.map((s) => ({ ...s, caption: LONG }))) },
  { name: "seq-short", title: "Short", body: { kind: "sequence", steps: SEQ3 }, spec: specSequence(SEQ3) },
  {
    name: "compare-long",
    title: "Compare these two things carefully please",
    body: {
      kind: "compare",
      left: { title: "Thirty chars of header text.", points: [LONG, "Short", "Another reasonably long bullet point here", "A fourth bullet"], image: ready },
      right: { title: "Right header", points: ["Never share codes", LONG], image: ready },
    },
    spec: {
      kind: "compare",
      left: { title: "Thirty chars of header text.", points: [LONG, "Short", "Another reasonably long bullet point here", "A fourth bullet"], imagePrompt: "x" },
      right: { title: "Right header", points: ["Never share codes", LONG], imagePrompt: "y" },
    },
  },
  {
    name: "anatomy-long",
    title: "Parts of the window explained in detail",
    body: { kind: "anatomy", image: ready, aspect: 1.2, callouts: [callout(1, "A label with forty characters in it, ok", 0.1, 0.1, 0.2, 0.2), callout(2, "Short", 0.5, 0.5, 0.2, 0.2), callout(3, LONG, 0.2, 0.7, 0.2, 0.2, false)] },
    spec: specAnatomy([callout(1, "A label with forty characters in it, ok", 0, 0, 0, 0), callout(2, "Short", 0, 0, 0, 0), callout(3, LONG, 0, 0, 0, 0)]),
  },
  {
    name: "concept-3",
    title: "What is the cloud and where does it live",
    body: {
      kind: "concept",
      panels: [
        { caption: "Ninety characters of caption text goes right here, and it keeps going on and on until the end.", image: ready },
        { caption: "Short one", image: loading("cloud") },
        { caption: "Medium length caption for the third panel", image: failed("cloud") },
      ],
    },
    spec: {
      kind: "concept",
      panels: [
        { caption: "Ninety characters of caption text goes right here, and it keeps going on and on until the end.", imagePrompt: "" },
        { caption: "Short one", imagePrompt: "" },
        { caption: "Medium length caption for the third panel", imagePrompt: "" },
      ],
    },
  },
];

export const CHECK_SCENES: GalleryScene[] = [
  { name: "check-labels", title: "Label measure stress (glyph)", targets: [], scene: checkLabels(true) },
  { name: "check-labels-plain", title: "Label measure stress (plain)", targets: [], scene: checkLabels(false) },
  ...CHECK_SPECS.map(
    (c): GalleryScene => ({
      name: `check-card-${c.name}`,
      title: `Card measure: ${c.name}`,
      targets: [],
      scene: scene([explainer("e", c.title, c.body, c.spec, { x: 40, y: 10 })]),
    }),
  ),
];

export const ALL_SCENES = [...SCENES, ...CHECK_SCENES];
export const findScene = (name: string) => ALL_SCENES.find((s) => s.name === name);
