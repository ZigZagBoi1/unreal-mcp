/**
 * House-style checks: the things a team's style guide forbids that compile and run fine.
 *
 * quality.ts asks "would a senior developer flag this?". This asks a narrower question that came
 * from a real cleanup: a developer hand-fixed an agent's graphs and the complaints were all of this
 * kind. Nodes stacked on nodes, a comment box around one node, comment boxes holding paragraphs,
 * widgets reading the player every frame, gameplay code fetching "player 0" (which is the host and
 * nobody else once there is a server), and server events that act without checking anything.
 *
 * Same rule as the rest of the review: conservative. Every check here has an obvious, ordinary
 * reading that it does not fire on.
 */

import type { LayoutNode } from "./layout.js";
import type { ChainGroup } from "./layout.js";
import { reviewLayout } from "./layoutReview.js";
import type { Finding } from "./quality.js";

/** What a node carries when the graph was read with positions. All optional: older reads omit them. */
interface PlacedNode extends LayoutNode {
  x?: number;
  y?: number;
  text?: string;
  holds?: string[];
  runsOn?: string;
}

export interface StyleContext {
  /** The Blueprint's parent class, e.g. "UserWidget". Decides whether widget rules apply. */
  parentClass?: string;
}

/** A comment box title past this many words is a sentence, not a name. */
const TITLE_MAX_WORDS = 5;
/** A comment past this many words in total is an essay; history belongs in the commit message. */
const COMMENT_MAX_WORDS = 30;

// Titles arrive both spaced ("Get Player Controller") and not ("GetPlayerController").
const PLAYER_INDEX_GETTER = /^get ?player ?(pawn|controller|character|camera ?manager|state)$/i;
const GATE_TITLE = /^(branch|switch|is ?valid|can[A-Z ]|try[A-Z ]|has[A-Z ]|is[A-Z ]|do ?once|gate)/i;
const GATE_TYPE = /K2Node_(IfThenElse|Switch|MacroInstance)/;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function styleFindings(
  allNodes: LayoutNode[],
  chains: ChainGroup[],
  context: StyleContext = {}
): Finding[] {
  const placed = allNodes as PlacedNode[];
  const nodes = placed.filter((node) => !/_Comment$/.test(node.type));
  const boxes = placed.filter((node) => /_Comment$/.test(node.type));
  const findings: Finding[] = [];

  // --- "Player 0" in gameplay. On a server it is the host, on a dedicated server it is nobody. ---
  const playerZero = nodes.filter((node) => PLAYER_INDEX_GETTER.test((node.title ?? "").trim()));
  if (playerZero.length > 0) {
    findings.push({
      check: "player-index-zero",
      severity: "warning",
      message: `${playerZero.length} node(s) fetch a player by index (Get Player Pawn/Controller 0).`,
      fix:
        "Use the owner, the instigator, the controller passed in, or Get Owning Player in a widget. Index 0 is " +
        "the host on a listen server and nobody on a dedicated one, so this works in solo testing and breaks online.",
      nodeIds: playerZero.map((node) => node.id),
    });
  }

  // --- A widget polling on Tick. Widgets should be pushed updates, not ask every frame. ---
  if (/widget/i.test(context.parentClass ?? "")) {
    const tick = nodes.find((node) => /\bTick\b/i.test(node.title ?? "") && /Event/.test(node.type));
    const wired = tick && (tick.connectedPins ?? []).some((pin) => pin.direction === "out" && (pin.linkedTo ?? []).length > 0);
    if (tick && wired) {
      findings.push({
        check: "widget-tick",
        severity: "warning",
        message: "This widget runs logic on Event Tick.",
        fix:
          "Update the widget from an event, a dispatcher or a RepNotify on the thing it shows. A HUD that reads " +
          "its player every frame costs frame time on every machine for values that change a few times a minute.",
        nodeIds: [tick.id],
      });
    }
  }

  // --- Comment boxes that are essays, or that wrap a single node. ---
  const essays = boxes.filter((box) => {
    const text = box.text ?? "";
    const title = text.split(/\r?\n/)[0] ?? "";
    return words(title) > TITLE_MAX_WORDS || words(text) > COMMENT_MAX_WORDS;
  });
  if (essays.length > 0) {
    findings.push({
      check: "comment-too-long",
      severity: "info",
      message: `${essays.length} comment box(es) read as sentences or paragraphs rather than names.`,
      fix:
        `Title a box with 1 to ${TITLE_MAX_WORDS} words naming the system ("Shooting", "Energy regen"), and add at ` +
        "most one short sentence of why. Credits and history go in the commit message.",
      nodeIds: essays.map((box) => box.id),
    });
  }
  const tiny = boxes.filter((box) => Array.isArray(box.holds) && box.holds.length === 1);
  if (tiny.length > 0) {
    findings.push({
      check: "comment-box-one-node",
      severity: "info",
      message: `${tiny.length} comment box(es) wrap a single node.`,
      fix:
        "A box names a system, so it should wrap the event and everything that event drives in this graph. Grow " +
        "it over the whole chain with unreal_organize_graph resize_comment_box, or use a node comment instead.",
      nodeIds: tiny.map((box) => box.id),
    });
  }

  // --- Nodes sitting on top of each other. Only judged when the read carried positions. ---
  if (nodes.some((node) => typeof node.x === "number")) {
    const stacked = reviewLayout(placed).findings.filter((finding) => finding.kind === "stacked");
    const ids = [...new Set(stacked.flatMap((finding) => finding.nodes))];
    if (ids.length > 0) {
      findings.push({
        check: "stacked-nodes",
        severity: "warning",
        message: `${ids.length} node(s) overlap another node.`,
        fix: "Run unreal_tidy_layout on this graph, or move them apart with unreal_organize_graph move_node.",
        nodeIds: ids,
      });
    }
  }

  // --- A server event that acts without checking anything first. ---
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const unchecked = chains.filter((chain) => {
    const root = byId.get(chain.rootId);
    if (!root || root.runsOn !== "server" || chain.nodeIds.length < 3) return false;
    return !chain.nodeIds.some((id) => {
      const node = byId.get(id);
      return !!node && id !== chain.rootId && (GATE_TYPE.test(node.type) || GATE_TITLE.test((node.title ?? "").trim()));
    });
  });
  if (unchecked.length > 0) {
    findings.push({
      check: "server-event-unchecked",
      severity: "info",
      message: `${unchecked.length} Run-on-Server event(s) act without a branch, validity check or Can/Try/Is test.`,
      fix:
        "A client can call a server event at any time, so check on the server that the caller is allowed: alive, " +
        "off cooldown, holding the thing. Never trust a value the client sent.",
      nodeIds: unchecked.map((chain) => chain.rootId),
    });
  }

  return findings;
}
