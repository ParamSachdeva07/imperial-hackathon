import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import type { AssistantStatus } from "./assistant/status";
import { buildMenuModel, tooltipFor, type MenuItemModel, type TrayActions, type TrayState } from "./trayModel";
import { drawTrayIcon, toBgra } from "./trayIcon";

export interface CreateTrayOptions {
  status: { get(): AssistantStatus; onChange(cb: (s: AssistantStatus) => void): () => void };
  actions: TrayActions;
  /** Current toggles, read each time the menu rebuilds. */
  getToggles(): { mouseEnabled: boolean; gesturesEnabled: boolean };
}

export interface PointyTray {
  /** Rebuild the menu (call after toggles or permissions change). */
  refresh(permissionsSummary?: string): void;
  destroy(): void;
}

function iconFor(status: AssistantStatus) {
  const img = nativeImage.createEmpty();
  for (const scale of [1, 2]) {
    const icon = drawTrayIcon(status, scale);
    img.addRepresentation({ scaleFactor: scale, width: icon.width, height: icon.height, buffer: toBgra(icon) });
  }
  img.setTemplateImage(true);
  return img;
}

function toElectron(items: MenuItemModel[]): MenuItemConstructorOptions[] {
  return items.map((m): MenuItemConstructorOptions => {
    switch (m.kind) {
      case "separator":
        return { type: "separator" };
      case "label":
        return { label: m.label, enabled: false };
      case "action":
        return { label: m.label, accelerator: m.accelerator, registerAccelerator: false, click: () => m.run() };
      case "checkbox":
        return { label: m.label, type: "checkbox", checked: m.checked, click: (item) => m.run(item.checked) };
    }
  });
}

export function createTray(opts: CreateTrayOptions): PointyTray {
  const tray = new Tray(iconFor(opts.status.get()));
  let summary: string | undefined;

  const render = () => {
    const status = opts.status.get();
    const state: TrayState = { status, ...opts.getToggles(), permissionsSummary: summary };
    tray.setImage(iconFor(status));
    tray.setToolTip(tooltipFor(status));
    tray.setContextMenu(Menu.buildFromTemplate(toElectron(buildMenuModel(state, opts.actions))));
  };
  render();
  const off = opts.status.onChange(render);

  return {
    refresh(s) {
      if (s !== undefined) summary = s;
      render();
    },
    destroy() {
      off();
      tray.destroy();
    },
  };
}
