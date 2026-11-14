export type TokenResult = { ok: true; sessionToken: string } | { ok: false; error: string };
export interface OverlayBridge {
  getSessionToken(): Promise<TokenResult>;
  requestMicrophone(): Promise<boolean>;
  setExpanded(expanded: boolean): Promise<void>;
  getLauncherVisibility(): Promise<boolean>;
  onLauncherVisibility(callback: (visible: boolean) => void): () => void;
  setLauncherFocused(focused: boolean): void;
  moveStart(): void;
  moveUpdate(): void;
  moveEnd(): void;
  resizeBy(amount: number): void;
  moveBy(x: number, y: number): void;
}
