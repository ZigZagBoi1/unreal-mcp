import { test } from "node:test";
import assert from "node:assert/strict";

import { boxColorFor } from "../dist/autoLayout.js";

// One colour per area so machine-drawn boxes scan like a hand-built graph, and no colour at all
// when the title says nothing about the area: a confident wrong colour is worse than the default.

test("networking, gameplay, UI and debug chains get their area colour", () => {
  assert.equal(boxColorFor("Server_StartFire").b, 1);
  assert.equal(boxColorFor("OnRep_DataHeld").b, 1);
  assert.equal(boxColorFor("EnhancedInputAction IA_Shoot").g, 0.85);
  assert.equal(boxColorFor("Update HUD").r, 1);
  assert.equal(boxColorFor("TEMP sound until Wwise").g, 0.3);
});

test("an unrecognised title keeps the editor default", () => {
  assert.equal(boxColorFor("RefreshHeadLiquidMaterial"), undefined);
});