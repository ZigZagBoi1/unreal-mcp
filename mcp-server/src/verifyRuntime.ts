/**
 * Watch values in a running game and say whether they agree, in one call.
 *
 * The pieces to do this existed - start_pie, watch_runtime start/read/stop, stop_pie - and using
 * them meant five calls with real time to pass between them, which is exactly the kind of sequence a
 * model gets wrong or skips. It skipped it here: a Blueprint fix was reported as done on the
 * strength of "it compiled", and compiling is not running. The person on the other end had to point
 * that out, and they were right.
 *
 * So the sequence is a tool. It starts the game if it is not already running, samples for a while,
 * reports, and puts everything back the way it found it - including leaving a session alone if the
 * caller had one open already.
 *
 * The verdict is the point. "Authority BP_Player_C_1=Starry, Client0 BP_Player_C_1=Starry" is a
 * replicated value confirmed; the same line with one side empty is the bug, named down to the actor.
 * A model reading this does not have to know what to compare.
 */

export interface RuntimeSample {
  watch: string;
  role: string;
  first?: unknown;
  last?: unknown;
  changed?: boolean;
  samples?: number;
  matchingActors?: number;
}

export interface RuntimeVerdict {
  watched: RuntimeSample[];
  /** One line per watched value: what every role ended up holding, and whether it ever moved. */
  agreement: Array<{ watch: string; agreed: boolean; moved: boolean; byRole: Record<string, string> }>;
  /** Values that never moved from their starting point, which usually means nothing set them. */
  neverChanged: string[];
  verdict: string;
}

/**
 * The values, without the actor names.
 *
 * The bridge labels a disagreement as `2 actors differ: BP_Player_C_1=Bunny | BP_Player_C_3=Squiddy`,
 * which is what makes it useful to a person. It is useless for comparing one role against another,
 * because PIE gives the same pawn a different suffix in every world - C_3 on the server is C_2 on the
 * client. Comparing the labelled strings said Authority and Client0 disagreed on every multi-actor
 * value, always, which is a verification tool crying wolf: the first thing anyone learns is to stop
 * reading it.
 *
 * So names are stripped for the comparison and kept for the report.
 */
function valuesOnly(raw: string): string {
  const differ = /^\d+ actors differ: (.*)$/.exec(raw);
  if (!differ) return raw;
  return differ[1]
    .split(" | ")
    .map((part) => {
      const at = part.indexOf("=");
      return at === -1 ? part : part.slice(at + 1);
    })
    .sort()
    .join(" | ");
}

/** Nothing there: the shapes an unwritten value actually takes. */
function looksUnset(raw: string): boolean {
  const value = valuesOnly(raw).trim();
  return value === "" || value === "None" || value === '""';
}

/**
 * A pass/fail line for a sampled value.
 *
 * "Did energy move" was answerable; "did one second of holding fire cost at most 24 energy" was not,
 * so a fire rate that was double the intended one read as working. Bounds are checked against every
 * value the watch saw, not only the ends: a value that dips while a key is held and recovers after
 * looks untouched at `first` and `last`.
 */
export interface RuntimeExpectation {
  watch: string;
  /** Only this role, e.g. "Authority". Omit to require it of every role that sampled the value. */
  role?: string;
  /** Every sampled value must be at least this. */
  min?: number;
  /** Every sampled value must be at most this. */
  max?: number;
  /** true: the value must change at some point. false: it must never change. */
  changes?: boolean;
}

export interface ExpectationResult {
  watch: string;
  role: string;
  pass: boolean;
  detail: string;
}

/** Every value a row saw, as numbers where they parse. The bridge joins distinct values with " -> ". */
function observedNumbers(row: RuntimeSample & { values?: unknown }): number[] {
  const raw: string[] = [String(row.first ?? ""), String(row.last ?? "")];
  if (Array.isArray(row.values)) raw.push(...row.values.map(String));
  else if (typeof row.values === "string") raw.push(...row.values.split(" -> "));
  // A multi-actor sample reads "80 | 82.5" once the names are stripped: every actor's value counts.
  return raw
    .flatMap((v) => valuesOnly(v).split(" | "))
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n));
}

export function checkExpectations(watched: RuntimeSample[], expectations: RuntimeExpectation[]): ExpectationResult[] {
  const results: ExpectationResult[] = [];
  for (const expect of expectations) {
    const rows = watched.filter((row) => row.watch === expect.watch && (!expect.role || row.role === expect.role));
    if (rows.length === 0) {
      results.push({ watch: expect.watch, role: expect.role ?? "any", pass: false, detail: "never sampled - check the class and property name" });
      continue;
    }
    for (const row of rows) {
      const seen = observedNumbers(row);
      const low = seen.length > 0 ? Math.min(...seen) : undefined;
      const high = seen.length > 0 ? Math.max(...seen) : undefined;
      const problems: string[] = [];
      if (expect.min !== undefined && (low === undefined || low < expect.min)) problems.push(`went down to ${low ?? "a non-number"}, expected at least ${expect.min}`);
      if (expect.max !== undefined && (high === undefined || high > expect.max)) problems.push(`went up to ${high ?? "a non-number"}, expected at most ${expect.max}`);
      if (expect.changes === true && row.changed !== true) problems.push("never changed");
      if (expect.changes === false && row.changed === true) problems.push("changed");
      results.push({
        watch: expect.watch,
        role: row.role,
        pass: problems.length === 0,
        detail: problems.length > 0 ? problems.join("; ") : `ok (range ${low ?? "?"} to ${high ?? "?"})`,
      });
    }
  }
  return results;
}

/** Roles collapse to one line per watched value, because that is the question being asked. */
export function summariseRuntime(watched: RuntimeSample[], pressed?: string): RuntimeVerdict {
  const byWatch = new Map<string, RuntimeSample[]>();
  for (const row of watched) {
    const list = byWatch.get(row.watch) ?? [];
    list.push(row);
    byWatch.set(row.watch, list);
  }

  const agreement: RuntimeVerdict["agreement"] = [];
  const neverChanged: string[] = [];

  for (const [watch, rows] of byWatch) {
    const byRole: Record<string, string> = {};
    for (const row of rows) byRole[row.role] = String(row.last ?? "");
    const values = [...new Set(Object.values(byRole).map(valuesOnly))];
    // Did it move at ANY point, not just where it ended up.
    //
    // `last` is sampled after the key is released, so a value that swung while an ability was held
    // reads as its resting default by the time anyone looks. The first version reported "every value
    // agreed" for a press that had visibly driven a charge meter off zero - true, and useless. Movement
    // is the question a press is asking.
    const moved = rows.some((r) => r.changed === true);
    agreement.push({ watch, agreed: values.length <= 1, moved, byRole });

    // A value identical from first sample to last, in every role, was probably never written. That
    // is not proof - a value can be correct from the start - but it is the shape of "nothing ran",
    // and it is the single most useful thing to say out loud when a fix appears to have no effect.
    // Stable AND empty. A value that held the right answer from the first sample is stable too, and
    // reporting that as suspicious is how this stops being read - the first version did exactly that
    // for a value that was correct throughout.
    if (
      rows.length > 0 &&
      rows.every((r) => r.changed === false && String(r.first) === String(r.last)) &&
      rows.some((r) => looksUnset(String(r.last ?? "")))
    ) {
      neverChanged.push(watch);
    }
  }

  const disagreeing = agreement.filter((a) => !a.agreed).map((a) => a.watch);
  const parts: string[] = [];
  if (disagreeing.length > 0) {
    parts.push(
      `${disagreeing.length} value(s) differ between roles: ${disagreeing.join(", ")}. ` +
        `A replicated value that differs between Authority and a client is a replication bug, and the ` +
        `actor names above say which copy is wrong.`
    );
  }
  if (neverChanged.length > 0) {
    parts.push(
      `${neverChanged.length} value(s) never changed during the whole session: ${neverChanged.join(", ")}. ` +
        `Either they were already correct, or nothing wrote them - check that whatever should set them ` +
        `is actually called, with unreal_trace_function_calls.`
    );
  }
  const inert = agreement.filter((a) => !a.moved).map((a) => a.watch);
  if (pressed && inert.length > 0) {
    parts.push(
      `${inert.length} value(s) never moved at any point while "${pressed}" was held: ${inert.join(", ")}. ` +
        `If the input was meant to drive them, either it is not reaching the game, or the thing it ` +
        `triggers needs something that is not there - a target in range, a resource, a state.`
    );
  }
  if (parts.length === 0) {
    parts.push(
      pressed
        ? `every watched value agreed across all running worlds, and each of them moved while "${pressed}" was held.`
        : "every watched value agreed across all running worlds and none looked unwritten."
    );
  }

  return { watched, agreement, neverChanged, verdict: parts.join(" ") };
}
