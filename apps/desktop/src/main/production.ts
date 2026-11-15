/**
 * Production composition (POINTY_MODE=production, see mode.ts): the real desktop instead of the fake mail
 * app. Accessibility elements (AxBoundsProvider) + screenshots feed GPT Realtime (text out); the answer is
 * spoken by the Anam avatar and drawn with the overlay tools. A menu-bar app: tray, Cmd+Alt+P, no Dock icon.
 * The dev composition lives in index.ts and is untouched by this file. See INTEGRATION.md section 10.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, screen } from "electron";
import { exportToolDefinitions, type ScreenCaptureProvider } from "@pointy/shared/overlay";
import { createOverlayControl, AnamAvatarClient, anamControlFile, imagesEnabled, readManifestPrompts } from "./overlay";
import { CompositeAvoidRects } from "./overlay/avatar/CompositeAvoidRects";
import { TurnAvoidRects } from "./overlay/avatar/TurnAvoidRects";
import { MockAvoidRects } from "./overlay/mocks/MockAvoidRects";
import { MockBoundsProvider } from "./overlay/mocks/MockBoundsProvider";
import { ElectronScreen } from "./overlay/OverlayWindowManager";
import { combineCaptureHiding, hideFeedbackDuringCapture } from "./gestures/captureHiding";
import { feedbackCaptureHiding } from "./gestures/feedbackHost";
import { startGestures, type GesturesHandle } from "./gestures/startGestures";
import { attachSelectionCapture, type SelectionSource } from "./capture/SelectionCapture";
import { bgraCapture, nativeImageOps } from "./capture/nativeImageOps";
import { DesktopCapturerProvider } from "./capture/DesktopCapturerProvider";
import { clearOnSessionClose, SelectionStore } from "./capture/SelectionStore";
import { AxBoundsProvider, AxHelperClient } from "./ax";
import { AssistantController, parseBargeIn } from "./assistant/AssistantController";
import { AnamSpeaker } from "./assistant/AnamSpeaker";
import { createAssistantWindow } from "./assistant/assistantWindow";
import { buildAssistantInstructions } from "./assistant/instructions";
import { mintAssistantSecret } from "./assistant/secret";
import { describeRealtimeConfig } from "./assistant/realtimeProtocol";
import { summarizeOverlays } from "./assistant/overlaySummary";
import { captureScreenContext, POINTER_ACTIVE_MS } from "./assistant/screenContext";
import { realClock } from "./overlay/clock";
import { checkPermissions, hideDockInProduction, openMissingSettings, registerAssistantHotkey } from "./permissions";
import { createTray } from "./tray";
import { createQuitGuard, createScrollInvalidator, pickPointer } from "./productionLogic";
import { loadRendererPage, PRELOAD_DIR } from "./rendererPages";
import { startDevHarness } from "../dev/devHarness";
import { ExecutionClient } from "./execution/ExecutionClient";
import { EXECUTION_TOOLS, ExecutionToolHost } from "./execution/ExecutionTools";
import { AgentSession } from "./agent/AgentSession";
import { ToolBridge } from "./agent/ToolBridge";
import type { StatusEmitter } from "./assistant/status";

/** Safety cap for the kept selection outline; the AssistantController removes it much earlier. */
const SELECTION_OUTLINE_TTL_MS = 120_000;

const plog = (msg: string) => console.log(`[pointy] ${msg}`);

/** Pids the AX helper must never snapshot: Pointy itself and the Anam avatar app (from its discovery file). */
function anamPid(): number | null {
  try {
    const j = JSON.parse(readFileSync(anamControlFile(), "utf8")) as { pid?: unknown };
    return typeof j.pid === "number" && Number.isInteger(j.pid) ? j.pid : null;
  } catch {
    return null;
  }
}

export interface ProductionOptions {
  repoRoot: string;
  contentProtection: boolean;
  /** Mode.devServer: also start the localhost dev server (pointy-draw) against the real AX ids. */
  devServer: boolean;
}

export async function startProduction(opts: ProductionOptions): Promise<void> {
  const { repoRoot } = opts;
  hideDockInProduction(true);
  const env = process.env;
  const displays = new ElectronScreen();
  const primary = () => displays.getDisplays().find((d) => d.id === displays.getPrimaryDisplayId());
  const assetsDir = join(repoRoot, "assets", "explainers");

  // --- real screen elements (Accessibility); without a grant the assistant falls back to screenshots
  const ax = new AxBoundsProvider({
    client: new AxHelperClient({ binPath: join(repoRoot, "apps/desktop/resources/bin/pointy-ax"), log: plog }),
    getDisplayMatching: (r) => screen.getDisplayMatching({ x: r.x, y: r.y, width: r.width, height: r.height }),
    // Pointy's own processes (main, renderers, GPU helpers: the overlay/feedback windows) and the Anam avatar app.
    excludePids: () => {
      const own = app.getAppMetrics().map((m) => m.pid);
      const a = anamPid();
      return [...new Set([process.pid, ...own, ...(a === null ? [] : [a])])];
    },
    // Screen/AX data is read only while the assistant is open (setSessionActive below); the dev server keeps it live.
    active: opts.devServer,
    log: plog,
  });
  await ax.start();
  plog(ax.trusted ? "accessibility: trusted (element list on)" : "accessibility: NOT granted, screenshot-only until it is granted");

  // --- avatar: the real Anam app drives avoid rects / move_avatar; nothing is avoided while it is unreachable
  const anam = new AnamAvatarClient();
  anam.start();

  const provider = new DesktopCapturerProvider(() => displays.getDisplays());
  const hideFeedback = (p: ScreenCaptureProvider): ScreenCaptureProvider =>
    env.POINTY_HIDE_DURING_CAPTURE === "1" ? hideFeedbackDuringCapture(p, feedbackCaptureHiding) : p;
  // Cards / label_parts title chips keep clear of the user's selection and the pointer close-up (set by the assistant per turn).
  const turnAvoid = new TurnAvoidRects();
  const overlay = createOverlayControl({
    cardAvoidRects: turnAvoid,
    boundsProvider: ax,
    captureProvider: hideFeedback(provider),
    avoidRects: new CompositeAvoidRects(anam, new MockAvoidRects(primary, "none")),
    avatar: anam,
    assetsDir,
    images: imagesEnabled(env),
    screen: displays,
    dev: {
      contentProtection: opts.contentProtection,
      hideDuringCapture: env.POINTY_HIDE_DURING_CAPTURE === "1",
      forceReduceMotion: env.POINTY_REDUCE_MOTION === "1",
    },
  });

  // Bumped on every desktop context change: the assistant skips coordinate tool calls built on an older screenshot.
  let contextRevision = 0;
  const invalidateContext = () => {
    contextRevision++;
    overlay.control.onContextChange();
  };
  const offAxContext = ax.onContextEvent(invalidateContext);

  // --- gestures: camera on, mouse on (kill switch in the tray), session driven only by the assistant
  const gestures: GesturesHandle | null = await startGestures({
    repoRoot,
    manualSession: true,
    // The selection outline stays until the assistant clears it (offer answered / declined / 15 s); this is only the safety cap.
    selectionTtlMs: SELECTION_OUTLINE_TTL_MS,
    env: {
      ...env,
      POINTY_GESTURES: env.POINTY_GESTURES === "0" ? "0" : "1",
      POINTY_GESTURES_MOUSE: env.POINTY_GESTURES_MOUSE === "0" ? "0" : "1",
    },
  });
  let gesturesEnabled = gestures !== null;

  const selectionStore = new SelectionStore();
  const hiding = combineCaptureHiding(
    { getWindowIds: () => overlay.control.getOverlayWindowIds(), withHidden: (fn) => overlay.control.withOverlayHidden(fn) },
    feedbackCaptureHiding,
  );
  const stopSelection: (() => void)[] = [];
  const clog = (level: "info" | "warn" | "error") => (msg: string) => console[level](`[selection] ${msg}`);
  // The temporary session pause while an answer is spoken (onAnswerSpeaking) is not a "session close": it must
  // not clear the SelectionStore, so the store only sees real closes.
  const attachSelection = (source: SelectionSource & { onSession(cb: (active: boolean) => void): () => void }): (() => void) => {
    const cap = attachSelectionCapture(source, {
      screen: { getDisplays: () => displays.getDisplays() },
      capture: bgraCapture(provider),
      hiding,
      ops: nativeImageOps,
      now: Date.now,
      log: { info: clog("info"), warn: clog("warn"), error: clog("error") },
      store: selectionStore,
    });
    const offClear = clearOnSessionClose(selectionStore, {
      onSession: (cb) => source.onSession((active) => (!active && gestures?.sessionPaused ? undefined : cb(active))),
    });
    return () => {
      cap.dispose();
      offClear();
    };
  };
  if (gestures) {
    try {
      stopSelection.push(attachSelection(gestures.events));
    } catch (err) {
      console.error(`[selection] capture not available: ${String(err)}`);
    }
  }

  // --- assistant: hidden Realtime window + controller
  const images = imagesEnabled(env);
  // --- execution agent (POINTY_EXECUTION=0 turns it off): the assistant can hand a request to it and keep talking
  const executionOn = env.POINTY_EXECUTION !== "0";
  let mouseBeforeTask = false;
  const execution = new ExecutionToolHost({
    client: new ExecutionClient(),
    announce: (text) => controller.notify(text),
    onTaskStart: () => {
      // The task acts on the real screen: remove our drawings from it and stop the hand from driving the mouse.
      void overlay.control.handleTool("clear", {}).catch(() => undefined);
      mouseBeforeTask = gestures?.mouseEnabled ?? false;
      if (mouseBeforeTask) gestures?.setMouseEnabled(false);
    },
    onTaskEnd: () => {
      if (mouseBeforeTask) gestures?.setMouseEnabled(true);
      invalidateContext(); // the screen is not what the last screenshot showed
    },
    log: plog,
  });
  const tools = [
    ...exportToolDefinitions({ images, pregeneratedImagePrompts: images ? await readManifestPrompts(assetsDir) : [] }),
    ...(executionOn ? EXECUTION_TOOLS : []),
  ];
  // --- the assistant. Two voice stacks share everything above:
  //   realtime   (default) OpenAI Realtime in a hidden window; the avatar only speaks our text
  //   elevenlabs           an ElevenLabs agent runs the conversation through the avatar; we run its tools
  const agentStack = env.POINTY_VOICE_STACK === "elevenlabs";
  interface Assistant {
    readonly status: StatusEmitter;
    isOpen(): boolean;
    open(reason?: string): Promise<void>;
    close(reason?: string): Promise<void>;
    wake(): Promise<void>;
    hotkey(): Promise<void>;
    interrupt(): Promise<void>;
    clearMemory(): void;
    notify(text: string): void;
    dispose(): void;
  }
  const buildContext = (o?: { skipScreenshot?: boolean }) =>
    captureScreenContext({
      skipScreenshot: o?.skipScreenshot,
      getDisplays: () => displays.getDisplays(),
      primaryDisplayId: () => displays.getPrimaryDisplayId(),
      cursorDisplayId: () => String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
      getPointer: () => {
        const real = screen.getCursorScreenPoint();
        // While the user points with a finger the real cursor may not follow (mouse control off / frozen after a selection).
        const g = gestures?.pointerActiveRecently(POINTER_ACTIVE_MS) ? gestures.lastPointer() : null;
        const p = pickPointer({ gestureActive: g !== null, gesture: g, real });
        return { x: p.x, y: p.y, displayId: String(screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }).id) };
      },
      pointerActiveRecently: (ms) => gestures?.pointerActiveRecently(ms) ?? false,
      overlays: () => summarizeOverlays(overlay.debug.items?.() ?? []),
      elementAt: async (p) => {
        const e = (await ax.elementAt?.(p)) ?? null;
        return e ? { id: e.id, role: e.role, label: e.label, window: e.window } : null;
      },
      capture: bgraCapture(provider),
      hiding,
      ops: nativeImageOps,
      ax,
      log: plog,
    });
  const gestureSession = {
    // The gesture session (and with it the mouse) is active only while the assistant is open.
    setSessionActive: (active: boolean) => {
      ax.setActive(active || opts.devServer);
      if (active) void ax.snapshotNow("session-open").catch(() => undefined); // attach AX observers even if the user selects before speaking
      if (!gestures) return;
      gestures.setSessionPaused(false, false); // a real open/close supersedes a pause for the spoken answer
      if (active && gesturesEnabled) gestures.session.open();
      else gestures.session.close();
    },
    clearSelection: () => gestures?.clearSelection(),
  };
  const runTool = (name: string, input: unknown, o?: Parameters<typeof overlay.control.handleTool>[2]) =>
    execution.handles(name) ? (execution.handle(name, input) as ReturnType<typeof overlay.control.handleTool>) : overlay.control.handleTool(name, input, o);
  let assistantWin: ReturnType<typeof createAssistantWindow> | null = null;
  let toolBridge: ToolBridge | null = null;
  let controller: Assistant;
  if (agentStack) {
    const session = new AgentSession({
      anam: new AnamSpeaker(),
      gestures: gestureSession,
      tools: { names: () => tools.map((t) => t.name), run: (name, input) => runTool(name, input) },
      buildContext: () => buildContext({ skipScreenshot: true }), // the agent reads the control list; it is given no image
      selectionNote: () => {
        const sel = selectionStore.latest();
        if (!sel) return "";
        const r = sel.regionGlobal;
        return `[selection] The user selected the area at ${Math.round(r.x)},${Math.round(r.y)} size ${Math.round(r.width)}x${Math.round(r.height)} with a gesture. Controls inside it in the list above are what they mean by "this".`;
      },
      backgroundWork: () => execution.isRunning(),
      clock: realClock,
      log: plog,
    });
    toolBridge = new ToolBridge({ toolNames: () => session.toolNames(), runTool: (name, input) => session.runTool(name, input), onSpoken: (e) => session.onSpoken(e), log: plog });
    await toolBridge.start();
    plog(`voice stack: elevenlabs through the avatar (tool bridge on :${toolBridge.port})`);
    controller = session;
  } else {
    plog(`realtime ${describeRealtimeConfig()}`);
    assistantWin = createAssistantWindow({
      preloadDir: PRELOAD_DIR,
      loadPage: (w) => loadRendererPage(w, "assistant"),
      mintSecret: async () => {
        const secret = await mintAssistantSecret({ apiKey: process.env.OPENAI_API_KEY, instructions: buildAssistantInstructions({ images, execution: executionOn }), tools });
        plog(`realtime session: model=${secret.model}, effort=${secret.effort ?? "default"}`);
        return secret;
      },
      log: plog,
    });
    const win = assistantWin;
    controller = new AssistantController({
      transport: win.transport,
      buildContext,
      anam: new AnamSpeaker(),
      overlay: {
        onTurnStart: (turnId) => overlay.control.onTurnStart(turnId),
        handleTool: runTool,
      },
      backgroundWork: () => execution.isRunning(),
      gestures: gestureSession,
      selection: selectionStore,
      bargeIn: parseBargeIn(env.POINTY_BARGE_IN),
      // Pause ONLY the gesture session while Anam speaks (so the open hand can interrupt and the mouse is not driven by a
      // hand that is just resting). Deliberately NOT the setSessionActive wrapper above: ax.setActive(false) would cancel
      // the anchors (target_lost, the AI's drawings vanish) and the selection must survive until the answer is done.
      onAnswerSpeaking: (speaking) => {
        if (!gestures) return;
        if (speaking) {
          if (gesturesEnabled && gestures.session.isActive()) gestures.setSessionPaused(true);
        } else if (gestures.sessionPaused) {
          // Also while gestures are toggled off: the pause flag must not outlive the speech (a stale flag makes the next pause a no-op).
          gestures.setSessionPaused(false, controller.isOpen() && gesturesEnabled);
        }
      },
      contextRevision: () => contextRevision,
      overlayState: () => summarizeOverlays(overlay.debug.items?.() ?? []),
      setTurnAvoid: (rects) => turnAvoid.set(rects),
      clock: realClock,
      log: plog,
    });
  }
  controller.status.onChange((s) => {
    if (s === "idle" || s === "error") {
      execution.dispose(); // the assistant closed: nobody is left to hear the result, so the task stops with it
      ax.clearAnchors();
      gestures?.clearSelection();
    }
  });
  const scrollInvalidates = createScrollInvalidator({
    mouseAttached: () => !!gestures && gestures.mouseEnabled && gestures.session.isActive(),
    now: () => Date.now(),
  });
  const offWake = gestures?.events.onAny((e) => {
    if (scrollInvalidates(e)) invalidateContext();
    if (e.type === "wake_requested" && gesturesEnabled) void controller.wake();
  });

  // --- menu bar, hotkey, permissions
  const tray = createTray({
    status: controller.status,
    getToggles: () => ({ mouseEnabled: gestures?.mouseEnabled ?? false, gesturesEnabled }),
    actions: {
      openAssistant: () => void controller.open("tray"),
      closeAssistant: () => void controller.close("tray"),
      stopTalking: () => void controller.interrupt(),
      startOver: () => controller.clearMemory(),
      setMouseEnabled: (on) => {
        gestures?.setMouseEnabled(on);
        tray.refresh();
      },
      setGesturesEnabled: (on) => {
        gesturesEnabled = on;
        gestures?.setSessionPaused(false, false); // a real toggle supersedes a pause for the spoken answer
        if (!on) gestures?.session.close();
        else if (controller.isOpen()) gestures?.session.open();
        tray.refresh();
      },
      checkPermissions: () => {
        const c = checkPermissions();
        plog(c.summary);
        tray.refresh(c.summary);
        void openMissingSettings(c);
      },
      quit: () => app.quit(),
    },
  });
  const hotkey = registerAssistantHotkey(() => void controller.hotkey());
  plog(hotkey.ok ? "hotkey Cmd+Option+P registered" : "hotkey Cmd+Option+P is taken by another app; use the menu-bar item");
  const perms = checkPermissions();
  plog(perms.summary);
  for (const d of perms.degraded) plog(`degraded: ${d}`);
  tray.refresh(perms.summary);
  if (perms.missing.length > 0) void openMissingSettings(perms);

  // --- optional dev server (POINTY_DEV_SERVER=1): pointy-draw against the real AX ids
  if (opts.devServer) {
    await ax.snapshotNow("dev-server").catch(() => undefined); // seed the element cache (observer events only fire on later changes)
    const sim = new MockBoundsProvider((rect) => String(screen.getDisplayMatching(rect).id));
    Object.assign(sim, {
      listElementIds: () => ax.listElements().map((e) => e.id),
      listElementRects: () => ax.listElements().map((e) => ({ id: e.id, rect: e.rect })),
    });
    await startDevHarness({
      overlay,
      boundsProvider: sim,
      screen: displays,
      assetsDir,
      images,
      openFixture: false,
      openVoice: false,
      selection: { store: selectionStore, attach: attachSelection },
      gestures: gestures ? { sim: gestures.sim, session: gestures.session } : null,
    });
  }

  const quitGuard = createQuitGuard({ close: () => controller.close("quit"), quit: () => app.quit() });
  app.on("before-quit", (event) => {
    // Let the Anam /session end go out before Electron exits (otherwise the external call stays open and billed).
    if (quitGuard()) {
      event.preventDefault();
      return;
    }
    offWake?.();
    hotkey.unregister();
    tray.destroy();
    execution.dispose();
    controller.dispose();
    assistantWin?.dispose();
    toolBridge?.stop();
    for (const d of stopSelection.splice(0)) d();
    gestures?.dispose();
    anam.dispose();
    offAxContext();
    ax.stop();
    overlay.dispose();
  });
  plog(`production overlay ready (contentProtection=${opts.contentProtection}, gestures=${gestures ? "on" : "off"})`);
}
