import { test } from "node:test";
import assert from "node:assert/strict";

import { checkExpectations } from "../dist/verifyRuntime.js";

// Built from the run that motivated it: one second of holding fire took Energy from 100 down to 80
// and it regenerated back to 100 before the last sample. Judged on first/last alone that is "no
// change"; the bounds have to be checked against every value the watch saw.
const energy = {
  watch: "BP_Player.Energy",
  role: "Authority",
  first: "100.000000",
  last: "100.000000",
  changed: true,
  values: "100.000000 -> 92.000000 -> 2 actors differ: BP_Player_C_0=80.000000 | BP_Player_C_1=82.500000 -> 100.000000",
};

test("a minimum is checked against the lowest value seen, not the ends", () => {
  const [ok] = checkExpectations([energy], [{ watch: "BP_Player.Energy", min: 76 }]);
  assert.equal(ok.pass, true, ok.detail);
  const [tooLow] = checkExpectations([energy], [{ watch: "BP_Player.Energy", min: 90 }]);
  assert.equal(tooLow.pass, false);
  assert.match(tooLow.detail, /went down to 80/);
});

test("a maximum fails with the value that broke it", () => {
  const [result] = checkExpectations([energy], [{ watch: "BP_Player.Energy", max: 50 }]);
  assert.equal(result.pass, false);
  assert.match(result.detail, /went up to 100/);
});

test("changes:true fails on a value that never moved", () => {
  const still = { watch: "BP_Player.bEnergyCooldown", role: "Authority", first: "False", last: "False", changed: false };
  const [result] = checkExpectations([still], [{ watch: "BP_Player.bEnergyCooldown", changes: true }]);
  assert.equal(result.pass, false);
});

test("a watch that was never sampled fails rather than passing silently", () => {
  const [result] = checkExpectations([energy], [{ watch: "BP_Player.Typo", min: 0 }]);
  assert.equal(result.pass, false);
  assert.match(result.detail, /never sampled/);
});
