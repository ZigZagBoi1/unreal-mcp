import { test } from "node:test";
import assert from "node:assert/strict";

import { diffGraph } from "../dist/diffGraph.js";

// The case it was written for: a hand cleanup that changed no text at all, only where nodes sit and
// how big the comment boxes are. A diff that only compared titles would report "no difference".

const n = (id, title, x, y) => ({ id, type: "K2Node_CallFunction", title, x, y });
const box = (id, text, x, y, width, height, color = "FFFFFFFF") => ({ id, type: "EdGraphNode_Comment", title: "Comment", text, x, y, width, height, color });

test("moved nodes and a stretched box are reported when nothing was renamed", () => {
  const before = [n("a", "Fire", 0, 0), n("b", "Spawn", 0, 0), box("c", "Shooting", 0, 0, 100, 50)];
  const after = [n("a", "Fire", 0, 0), n("b", "Spawn", 300, 0), box("c", "Shooting", -20, -40, 600, 200)];
  const diff = diffGraph(before, after);
  assert.equal(diff.moved.count, 1);
  assert.equal(diff.moved.examples[0].id, "b");
  assert.deepEqual(diff.boxes.map((b) => b.change), ["geometry"]);
  assert.equal(diff.added.length + diff.removed.length, 0);
});

test("added, removed, retitled and recoloured are each named", () => {
  const before = [n("a", "Print String", 0, 0), box("c", "Big paragraph about everything", 0, 0, 10, 10)];
  const after = [n("d", "Branch", 0, 0), box("c", "Shooting", 0, 0, 10, 10, "4073FFFF")];
  const diff = diffGraph(before, after);
  assert.deepEqual(diff.added.map((x) => x.title), ["Branch"]);
  assert.deepEqual(diff.removed.map((x) => x.title), ["Print String"]);
  assert.deepEqual(diff.boxes.map((b) => b.change).sort(), ["color", "text"]);
});

test("identical graphs say so", () => {
  const g = [n("a", "Fire", 1, 2)];
  assert.match(diffGraph(g, g).summary, /No difference/);
});
