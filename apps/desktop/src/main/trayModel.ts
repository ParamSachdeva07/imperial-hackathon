/** Pure menu-bar model. No electron imports. */
import type { AssistantStatus } from "./assistant/status";

export const ASSISTANT_HOTKEY = "CommandOrControl+Alt+P";

export const STATUS_LABEL: Record<AssistantStatus, string> = {
  idle: "Idle",
  opening: "Opening...",
  listening: "Listening",
  thinking: "Thinking...",
  speaking: "Speaking",
  error: "Error",
};

export interface TrayState {
  status: AssistantStatus;
  mouseEnabled: boolean;
  gesturesEnabled: boolean;
  permissionsSummary?: string;
}

export interface TrayActions {
  openAssistant(): void;
  closeAssistant(): void;
  /** Interrupt the current answer / speech (keeps the assistant open and the conversation). */
  stopTalking?(): void;
  /** Forget the rolling conversation memory. */
  startOver?(): void;
  setMouseEnabled(on: boolean): void;
  setGesturesEnabled(on: boolean): void;
  checkPermissions(): void;
  quit(): void;
}

export type MenuItemModel =
  | { kind: "label"; label: string }
  | { kind: "action"; label: string; accelerator?: string; run: () => void }
  | { kind: "checkbox"; label: string; checked: boolean; run: (checked: boolean) => void }
  | { kind: "separator" };

export function isAssistantActive(status: AssistantStatus): boolean {
  return status !== "idle" && status !== "error";
}

export function tooltipFor(status: AssistantStatus): string {
  return `Pointy: ${STATUS_LABEL[status]}`;
}

export function buildMenuModel(state: TrayState, actions: TrayActions): MenuItemModel[] {
  const active = isAssistantActive(state.status);
  const items: MenuItemModel[] = [
    { kind: "label", label: `Pointy: ${STATUS_LABEL[state.status]}` },
    { kind: "separator" },
    // The hotkey interrupts (double-press closes), so Close shows no accelerator.
    active
      ? { kind: "action", label: "Close assistant", run: actions.closeAssistant }
      : { kind: "action", label: "Open assistant", accelerator: ASSISTANT_HOTKEY, run: actions.openAssistant },
    ...(actions.stopTalking && (state.status === "speaking" || state.status === "thinking") ? [{ kind: "action", label: "Stop talking", accelerator: ASSISTANT_HOTKEY, run: actions.stopTalking } as MenuItemModel] : []),
    ...(actions.startOver ? [{ kind: "action", label: "Start over (forget conversation)", run: actions.startOver } as MenuItemModel] : []),
    { kind: "separator" },
    { kind: "checkbox", label: "Mouse control (kill switch)", checked: state.mouseEnabled, run: actions.setMouseEnabled },
    { kind: "checkbox", label: "Gestures", checked: state.gesturesEnabled, run: actions.setGesturesEnabled },
    { kind: "separator" },
    { kind: "action", label: "Check permissions...", run: actions.checkPermissions },
  ];
  if (state.permissionsSummary) items.push({ kind: "label", label: state.permissionsSummary });
  items.push({ kind: "separator" }, { kind: "action", label: "Quit Pointy", accelerator: "CommandOrControl+Q", run: actions.quit });
  return items;
}
