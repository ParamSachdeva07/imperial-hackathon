export const BACKEND_PORT: number;
export const UV_COMMAND: string;
export function isFinderDuplicate(name: string): boolean;
export function parseEnvKeys(text: string): Set<string>;
export function nodeMajor(version: string): number;
export interface MtimeIo {
  readdir(dir: string): { name: string; isDir: boolean }[];
  mtime(path: string): number;
}
export function newestMtime(dir: string, io: MtimeIo): number;
export function isStale(o: { srcDirs: string[]; outDir: string; io: MtimeIo; extraSrcFiles?: string[] }): boolean;
export interface PreflightDeps {
  root: string;
  env: Record<string, string | undefined>;
  nodeVersion: string;
  exists(path: string): boolean;
  readText(path: string): string;
  io: MtimeIo;
  portState(port: number): Promise<"free" | "ours" | "busy">;
  noAnam?: boolean;
  rebuild?: boolean;
}
export interface PreflightCheck {
  id: string;
  ok: boolean;
  message: string;
  fix?: string;
}
export interface PreflightResult {
  checks: PreflightCheck[];
  ok: boolean;
  needsBuild: { desktop: boolean; anam: boolean };
  needsGestureAssets: boolean;
  backendRunning: boolean;
}
export function runPreflight(deps: PreflightDeps): Promise<PreflightResult>;
export function pointyEnv(base: Record<string, string | undefined>, o: { debug: boolean }): Record<string, string | undefined>;
export function anamEnv(base: Record<string, string | undefined>): Record<string, string | undefined>;
export function parseArgs(argv: string[]): { help: boolean; check: boolean; noAnam: boolean; rebuild: boolean; debug: boolean; unknown: string[] };
