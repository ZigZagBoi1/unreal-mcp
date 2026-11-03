/**
 * What changed in a graph between two versions of a Blueprint.
 *
 * Asked for after a developer hand-cleaned an agent's graphs and the agent was meant to learn from
 * the cleanup. A text dump of each version showed no difference at all - the comment text was
 * identical - because what the person changed was WHERE things were: 56 nodes moved, overlaps
 * removed, comment boxes stretched over whole systems. Only positions and box geometry show that.
 */

interface DiffNode {
  id: string;
  type: string;
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
}

export interface GraphDiff {
  added: Array<{ id: string; title: string }>;
  removed: Array<{ id: string; title: string }>;
  moved: { count: number; examples: Array<{ id: string; title: string; dx: number; dy: number }> };
  boxes: Array<{ id: string; change: string; before?: string; after?: string }>;
  summary: string;
}

const isBox = (node: DiffNode): boolean => /_Comment$/.test(node.type);

export function diffGraph(before: DiffNode[], after: DiffNode[]): GraphDiff {
  const old = new Map(before.map((n) => [n.id, n]));
  const now = new Map(after.map((n) => [n.id, n]));
  const label = (n: DiffNode): string => (isBox(n) ? `box "${(n.text ?? "").split(/\r?\n/)[0]}"` : n.title);

  const added = after.filter((n) => !old.has(n.id)).map((n) => ({ id: n.id, title: label(n) }));
  const removed = before.filter((n) => !now.has(n.id)).map((n) => ({ id: n.id, title: label(n) }));

  const movedAll: GraphDiff["moved"]["examples"] = [];
  const boxes: GraphDiff["boxes"] = [];
  for (const n of after) {
    const was = old.get(n.id);
    if (!was) continue;
    const dx = (n.x ?? 0) - (was.x ?? 0);
    const dy = (n.y ?? 0) - (was.y ?? 0);
    if (!isBox(n) && (dx !== 0 || dy !== 0)) movedAll.push({ id: n.id, title: n.title, dx, dy });
    if (isBox(n)) {
      if ((was.text ?? "") !== (n.text ?? "")) boxes.push({ id: n.id, change: "text", before: was.text, after: n.text });
      if ((was.color ?? "") !== (n.color ?? "")) boxes.push({ id: n.id, change: "color", before: was.color, after: n.color });
      const geo = (d: DiffNode): string => `${d.x},${d.y} ${d.width}x${d.height}`;
      if (geo(was) !== geo(n)) boxes.push({ id: n.id, change: "geometry", before: geo(was), after: geo(n) });
    }
  }
  movedAll.sort((a, b) => Math.abs(b.dx) + Math.abs(b.dy) - (Math.abs(a.dx) + Math.abs(a.dy)));

  const parts = [
    added.length && `${added.length} added`,
    removed.length && `${removed.length} removed`,
    movedAll.length && `${movedAll.length} node(s) moved`,
    boxes.length && `${boxes.length} comment box change(s)`,
  ].filter(Boolean);
  return {
    added,
    removed,
    moved: { count: movedAll.length, examples: movedAll.slice(0, 10) },
    boxes,
    summary: parts.length > 0 ? parts.join(", ") + "." : "No difference in nodes, positions or comment boxes.",
  };
}
