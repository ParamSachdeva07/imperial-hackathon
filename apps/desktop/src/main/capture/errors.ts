/** Errors for the selection-capture path. Pure (no Electron), so SelectionCapture can recognise them. */

export class ScreenPermissionError extends Error {
  readonly code = "SCREEN_PERMISSION";
  constructor(readonly status: string) {
    super(
      `Screen Recording permission is "${status}". Open System Settings > Privacy & Security > Screen Recording, ` +
        `enable Electron (or the app you launched it from), then relaunch the app.`,
    );
    this.name = "ScreenPermissionError";
  }
}

export function isScreenPermissionError(e: unknown): e is ScreenPermissionError {
  return e instanceof ScreenPermissionError || (e instanceof Error && e.name === "ScreenPermissionError");
}
