/** One definition of "the same element", used by the ledger, checks and retrieval. */
export type ElementIdentity = {
  app: string;
  windowId?: string;
  role: string;
  label: string;
  nativeId?: { kind: string; value: string };
  /**
   * The path from the root of the read down to the parent. Each entry is `role#n`, the role and
   * its position among same-role siblings, so the same button in two different rows differs.
   * The root of a read has no known position and is written `role#*`.
   */
  ancestorRoles: string[];
  /** Position among same-role siblings under the same parent. */
  siblingIndex: number;
};
export type Match = 'exact' | 'strong' | 'weak' | 'none';

const rank: Record<Match, number> = { none: 0, weak: 1, strong: 2, exact: 3 };
export function atLeast(match: Match, minimum: Match): boolean {
  return rank[match] >= rank[minimum];
}

/** AppKit assigns `_NS:` identifiers per view instance; they do not identify a control. */
function stableNativeId(identity: ElementIdentity): string | undefined {
  const id = identity.nativeId;
  return id && !id.value.startsWith('_NS:') ? id.kind + '\u0000' + id.value : undefined;
}
/** A read scoped to a region or surface starts lower in the tree, so its paths are suffixes of the window's. */
function samePosition(a: ElementIdentity, b: ElementIdentity): boolean {
  const [short, long] = a.ancestorRoles.length <= b.ancestorRoles.length ? [a.ancestorRoles, b.ancestorRoles] : [b.ancestorRoles, a.ancestorRoles];
  const sameStep = (x: string, y: string) => x === y ||
    ((x.endsWith('#*') || y.endsWith('#*')) && x.slice(0, x.lastIndexOf('#')) === y.slice(0, y.lastIndexOf('#')));
  return a.siblingIndex === b.siblingIndex && short.every((step, index) => sameStep(step, long[long.length - short.length + index]));
}

/**
 * exact:  everything observed agrees.
 * strong: a stable native ID agrees together with the label or the position, or label plus
 *         ancestor path plus sibling index agree. A native ID alone is not enough: applications
 *         give one ID to a whole family of controls (every tab, every row's button).
 * weak:   role and a non-empty label agree. Enough for presence, not for reading a value.
 */
export function matchIdentity(a: ElementIdentity, b: ElementIdentity): Match {
  if (a.app !== b.app || a.role !== b.role) return 'none';
  const sameWindow = !a.windowId || !b.windowId || a.windowId === b.windowId;
  const idA = stableNativeId(a), idB = stableNativeId(b);
  const sameLabel = a.label === b.label;
  if (idA && idB && idA !== idB) return sameLabel && a.label ? 'weak' : 'none';
  const sameId = !!idA && idA === idB;
  const positioned = samePosition(a, b);
  const labelled = sameLabel && !!a.label;
  if (sameWindow && sameLabel && positioned && a.ancestorRoles.length === b.ancestorRoles.length &&
      (sameId || (!idA && !idB && !!a.label))) return 'exact';
  if (sameWindow && ((sameId && (labelled || positioned)) || (labelled && positioned))) return 'strong';
  if (labelled || sameId) return 'weak';
  // Two unlabeled controls with no stable ID can only be related by position.
  return sameWindow && sameLabel && !idA && !idB && positioned ? 'weak' : 'none';
}

export function describeIdentity(identity: ElementIdentity): string {
  return identity.role + ' ' + JSON.stringify(identity.label) + ' in ' + identity.app;
}
