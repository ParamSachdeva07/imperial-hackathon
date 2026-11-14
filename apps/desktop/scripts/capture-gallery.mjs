/**
 * Plain Electron main script: loads the built gallery for each scene/background and saves PNGs
 * to artifacts/gallery/ (repo root, gitignored). Also runs the measure check and prints its report.
 *
 *   npx electron-vite build && npx electron scripts/capture-gallery.mjs [sceneFilter]
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page = resolve(here, "../out/renderer/gallery/index.html");
const outDir = resolve(here, "../../../artifacts/gallery");
const filter = process.argv.slice(2).find((a) => !a.startsWith("-") && !a.endsWith(".mjs"));

const SETTLED = 9000;
// [scene, t]: `t` freezes animations; extra mid-motion frames are saved as <scene>@<t>.
const SCENES = [
  "ring-labeled", "ring-glyph", "underline-labeled", "underline-glyph",
  "spotlight-info-label", "spotlight-warning-glyph", "spotlight-success-label", "spotlight-polygon",
  "ring-shapes", "pointer-tap", "pointer-double-tap", "pointer-drag", "pointer-label",
  "pointer-top", "pointer-right", "pointer-bottom", "steps",
  "explainer-sequence", "explainer-sequence-5", "explainer-compare", "explainer-compare-images",
  "explainer-anatomy", "explainer-anatomy-legend-only",
  "explainer-concept-loading", "explainer-concept-ready", "explainer-concept-failed",
  "reduce-motion", "exiting",
].map((s) => [s, s === "exiting" ? 150 : SETTLED]);
const EXTRA = [
  ["ring-labeled", 900], ["pointer-tap", 250], ["pointer-tap", 1350], ["pointer-drag", 1900], ["pointer-double-tap", 1150],
  ["pointer-top", 250], ["pointer-right", 250], ["pointer-bottom", 250], ["explainer-sequence", 120], ["explainer-concept-loading", 1300],
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function load(win, query) {
  await win.loadURL(`${pathToFileURL(page).href}?${query}`);
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript("document.documentElement.dataset.ready === '1'")) return;
    await wait(50);
  }
  throw new Error(`timeout: ${query}`);
}

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  const win = new BrowserWindow({ width: 1280, height: 800, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: false } });
  win.setContentSize(1280, 800);
  let failed = 0;
  try {
    await load(win, "check=1");
    const result = await win.webContents.executeJavaScript("window.__check");
    writeFileSync(resolve(outDir, "check.json"), JSON.stringify(result, null, 2));
    console.log(`measure check: ${result.overflows} overflow(s) in ${result.rows.length} boxes`);
    for (const r of result.rows) {
      if (r.overflow || process.argv.includes("--verbose")) console.log(`  ${r.overflow ? "OVERFLOW" : "ok"} ${r.kind} ${r.scene} ${r.box} slack=${r.slack} "${r.text.slice(0, 40)}"`);
    }
    if (result.overflows > 0) failed = 1;

    for (const [scene, t] of [...SCENES, ...EXTRA]) {
      if (filter && !scene.includes(filter)) continue;
      for (const bg of ["light", "dark"]) {
        await load(win, `scene=${scene}&bg=${bg}&t=${t}`);
        await wait(120);
        const image = await win.webContents.capturePage();
        const file = resolve(outDir, `${scene}${t === SETTLED || scene === "exiting" ? "" : `@${t}`}.${bg}.png`);
        writeFileSync(file, image.toPNG());
        console.log("saved", file);
      }
    }
  } catch (e) {
    console.error(e);
    failed = 1;
  }
  app.exit(failed);
});
