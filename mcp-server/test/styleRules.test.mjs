import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewGraph } from "../dist/quality.js";

// The house-style checks, each built from what a developer actually fixed by hand in an agent's
// graphs: stacked nodes, one-node comment boxes, paragraph comments, a widget polling its player
// every frame, Get Player Controller 0 in gameplay, and server events that act without a check.

const node = (id, type, title, pins = [], extra = {}) => ({ id, type, title, connectedPins: pins, ...extra });
const exec = (to) => ({ pin: "then", direction: "out", linkedTo: to.map((n) => ({ node: n, pin: "execute" })) });
const checks = (report) => (report.findings ?? []).map((f) => f.check);

test("Get Player Controller by index is reported, spaced or not", () => {
  for (const title of ["GetPlayerController", "Get Player Pawn"]) {
    const report = reviewGraph("EventGraph", [
      node("ev", "K2Node_Event", "Event BeginPlay", [exec(["get"])]),
      node("get", "K2Node_CallFunction", title),
    ]);
    assert.ok(checks(report).includes("player-index-zero"), `${title}: ${checks(report).join(", ")}`);
  }
});

test("Get Owning Player is not reported", () => {
  const report = reviewGraph("EventGraph", [node("get", "K2Node_CallFunction", "Get Owning Player")]);
  assert.ok(!checks(report).includes("player-index-zero"));
});

test("a widget with logic on Tick is reported, an actor is not", () => {
  const graph = [
    node("tick", "K2Node_Event", "Event Tick", [exec(["set"])]),
    node("set", "K2Node_CallFunction", "Set Percent"),
  ];
  assert.ok(checks(reviewGraph("EventGraph", graph, { parentClass: "UserWidget" })).includes("widget-tick"));
  assert.ok(!checks(reviewGraph("EventGraph", graph, { parentClass: "Actor" })).includes("widget-tick"));
});

test("a paragraph in a comment box is reported, a short title is not", () => {
  const essay = "This box handles the shooting for Sam and Alex and also explains in detail how the weapon " +
    "timer works and why the server owns it and what the client does in the meantime while it waits";
  const long = reviewGraph("EventGraph", [node("c1", "EdGraphNode_Comment", "Comment", [], { text: essay, holds: ["a", "b"] })]);
  assert.ok(checks(long).includes("comment-too-long"));
  const short = reviewGraph("EventGraph", [node("c1", "EdGraphNode_Comment", "Comment", [], { text: "Shooting", holds: ["a", "b"] })]);
  assert.ok(!checks(short).includes("comment-too-long"));
});

test("a comment box around one node is reported", () => {
  const report = reviewGraph("EventGraph", [
    node("c1", "EdGraphNode_Comment", "Comment", [], { text: "Spawn", holds: ["n1"] }),
    node("n1", "K2Node_CallFunction", "Spawn Actor"),
  ]);
  assert.ok(checks(report).includes("comment-box-one-node"));
});

test("a server event that acts with no check is reported, one with a Branch is not", () => {
  const chain = (gate) => [
    node("ev", "K2Node_CustomEvent", "Server_StartFire", [exec([gate ? "br" : "a"])], { runsOn: "server" }),
    ...(gate ? [node("br", "K2Node_IfThenElse", "Branch", [exec(["a"])])] : []),
    node("a", "K2Node_CallFunction", "Start Firing", [exec(["b"])]),
    node("b", "K2Node_CallFunction", "Spawn Actor"),
  ];
  assert.ok(checks(reviewGraph("EventGraph", chain(false))).includes("server-event-unchecked"));
  assert.ok(!checks(reviewGraph("EventGraph", chain(true))).includes("server-event-unchecked"));
});

test("stacked nodes are only judged when the read carried positions", () => {
  const onTop = [
    node("ev", "K2Node_Event", "Event BeginPlay", [exec(["a"])], { x: 0, y: 0 }),
    node("a", "K2Node_CallFunction", "Do Thing", [], { x: 0, y: 0 }),
  ];
  assert.ok(checks(reviewGraph("EventGraph", onTop)).includes("stacked-nodes"));
  const noPositions = onTop.map(({ x, y, ...rest }) => rest);
  assert.ok(!checks(reviewGraph("EventGraph", noPositions)).includes("stacked-nodes"));
});
