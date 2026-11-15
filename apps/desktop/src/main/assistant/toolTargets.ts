/** Pure helper: does a tool call position anything by screen coordinates (rect/point/polygon targets)? */
const COORDINATE_KINDS = new Set(["rect", "point", "polygon"]);

/** True if any object nested in `args` is a coordinate target ({kind:"rect"|"point"|"polygon"}). Element-id targets are not. */
export function usesCoordinateTargets(args: unknown, depth = 0): boolean {
  if (depth > 8 || args === null || typeof args !== "object") return false;
  if (Array.isArray(args)) return args.some((a) => usesCoordinateTargets(a, depth + 1));
  const o = args as Record<string, unknown>;
  if (typeof o.kind === "string" && COORDINATE_KINDS.has(o.kind)) return true;
  return Object.values(o).some((v) => usesCoordinateTargets(v, depth + 1));
}
