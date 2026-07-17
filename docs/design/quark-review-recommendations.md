# Quark Timeline Experiment: Review Recommendations

Status: point-in-time review feedback; accepted performance and correctness findings implemented
Reviewed: `docs/design/quark-performance-model.md`, `docs/design/quark-tui-timeline.md`, `packages/quark/src/*`, `packages/tui/src/routes/session/rows.ts`, `packages/tui/src/routes/session/index.tsx`

Goal: really fast and really beautiful. These are ordered recommendations for the next agent. Each item is independently actionable; the order reflects priority.

This document preserves the audit as written. The current implementation has
checked benchmarks and adverse workloads, structural-only boundaries,
precomputed IDs, shared grouping policy, filtered permission repartition,
optional publication counters, deterministic counter tests, and an `O(1)`
seen-part duplicate path. Current evidence and commands live in
`quark-performance-model.md` and `quark-tui-timeline.md`; claims below describe
the pre-fix state. Optional API polish and broader model/index/layout work are
deferred to avoid expanding the timeline landing.

## 1. Check in the microbenchmark

`quark-performance-model.md` cites concrete numbers (177.2µs vs 863.7µs, etc.) but the benchmark source is not in the tree. Unreproducible numbers are the weakest part of an otherwise careful doc.

- Add the benchmark under `packages/quark/bench/keyed.bench.ts` (or similar).
- Add the exact repro command to the "Controlled Benchmark Evidence" section of `quark-performance-model.md`.
- Add the adverse workloads promised in "When Quark Should Lose" (tiny lists, unstable keys, dense mutation, no subscribers, direct `setStore(index, "field", value)` on the Solid side). That section is currently a promise, not a suite.

## 2. Benchmark the actual hot path: incremental `update` with subscribed `values`

The checked-in benchmark story compares `Keyed.set(nextArray)` vs Solid `reconcile(nextArray)`. But after the migration, the streaming hot path is **incremental**: `state.update({...previous, refs: [...refs, ref]})` per delta (`packages/tui/src/routes/session/rows.ts`). Whole-array `set` only runs on reconnect/revert/compaction.

Add a workload: one `update` on a group row, with `values` subscribed, at 100 / 1,000 / 10,000 rows. This measures what the TUI actually does per streaming delta.

## 3. Fix the hidden O(N) per value change through `values` + `boundaries`

The performance-model doc presents `values` as "lazy without subscribers," but in the real integration it is **always subscribed**:

```ts
// packages/tui/src/routes/session/index.tsx (~line 190)
const boundaries = createMemo(() => messageBoundaryIDs([...rows.values()], messages()))
```

So every value-only change that survives `sameRow` pays:

- O(N) recompute of the `values` computed (N slot reads + dependency tracking, `packages/quark/src/keyed.ts:22-25`)
- O(N) `same` compare
- O(N) array spread in the memo
- a full `messageBoundaryIDs` recompute

The structural cutoff for `<For>` is real, but this is the remaining per-delta O(N) path. Options, in increasing ambition:

1. Change `messageBoundaryIDs` to accept `readonly SessionRow[]` so the spread copy dies (trivial).
2. Derive boundaries from `slots` plus per-slot reads so a group value change cannot invalidate them.
3. Maintain boundary info incrementally inside the same mutate operations that change structure.

At minimum, the doc should state the real cost with a measured number instead of implying laziness the integration doesn't have.

## 4. Replace `JSON.stringify` row keys with cheap concatenation

`rowKey` calls `JSON.stringify` per row per `set` (`packages/tui/src/routes/session/rows.ts:439-445`). On a 10,000-row `set` that's 10,000 serializer calls plus allocations, working directly against the "compile repeated decisions once" thesis.

Use a delimiter that cannot appear in IDs:

```ts
function rowKey(row: SessionRow) {
  if (row.type === "message") return `message\x00${row.messageID}`
  if (row.type === "compaction-queued") return `compaction-queued\x00${row.inputID}`
  if (row.type === "part") return `part\x00${row.ref.messageID}\x00${row.ref.partID}`
  if (row.type === "assistant-footer") return `assistant-footer\x00${row.messageID}`
  return `group\x00${row.kind}\x00${row.key.messageID}\x00${row.key.partID}`
}
```

Re-measure after; expect a meaningful constant-factor win on key extraction. Update the code sample in `quark-performance-model.md` to match.

## 5. Unify the two grouping-policy engines

There are now two implementations of the row grouping rules:

- The batch rebuild path: `reduce()` builds a plain array via the old `append` / `completePrevious` helpers (`rows.ts:385+`), then calls `state.set`.
- The incremental path: `appendPart` / `appendMessage` / `complete` closures reimplement the same join/complete decisions inline (`rows.ts:147-215`).

The performance-model doc's own decision rule #5 says "TUI code does not grow its own reconciliation engine" — this duplication is exactly that risk. Extract the shared decisions as pure functions, e.g. `joinsPreviousGroup(previous, part)` and `newRowFor(part, ref)`, and have both paths consume them. Do not lose the incremental path's precision; only deduplicate the policy.

## 6. Filter before cloning in permission repartition

The pending-permissions effect clones **every** exploration group on every change before `sameRow` suppresses the no-ops (`rows.ts:83-91`):

```ts
state.values().forEach((row) => {
  if (row.type !== "group" || row.kind !== "exploration") return
  const next = { ...row, refs: [...row.refs], pending: [...row.pending] }
  partitionPending([next], pending)
  state.update(next)
})
```

Filter to groups whose refs actually intersect the pending set before cloning. The clone-then-compare pattern spends the allocations the equivalence law was supposed to save.

## 7. Add work counters to `Keyed`

The strongest section of the performance model is "The Next Tests Must Measure Work, Not Just Time" — but `Keyed` has no instrumentation, so none of that table can be produced today.

Add optional counters behind a debug flag in `packages/quark/src/keyed.ts`:

- slot publications (value writes)
- structural publications (outer `slots` writes)
- equivalence suppressions (writes avoided by `equivalent`)

Then run the deterministic trace via `script/quark-timeline-drive.ts` and fill in the expected-behavior table with real counts. This converts the decision rule from vibes to numbers.

## 8. Demonstrate the "beautiful" claim with a recording

The user-visible payoff — stable component ownership means no flicker, no reset of expanded reasoning groups, no scroll jumps during permission repartition — is asserted but never demonstrated.

Capture a terminal-control recording of an expanded group surviving a permission repartition on this branch vs untouched `origin/v2`. That artifact is more persuasive than any benchmark table and belongs alongside it in the doc.

## 9. Small API and code polish

- ~~`insert(value, { before? })` where `before: undefined` means append reads poorly at call sites.~~ Fixed with the shared `Position<Key>` vocabulary: `"end"`, `{ before: key }`, or `{ after: key }`.
- The duplicate-key error in `Keyed.set` should name the offending key (`packages/quark/src/keyed.ts:32`).
- `update` mixes contracts: throws on missing key, returns `false` on no-op. That's defensible (missing key is a programmer error) but should be documented as a law.
- Doc correction in `quark-performance-model.md`, "Asymptotics and Constants": it claims "one key extraction per previous and next item," but the implementation only extracts **next** keys; previous slots are reached through the `byKey` map (`keyed.ts:30-52`). Fix the claim.

## What is already good (do not churn)

- The two-channel `slots` / `values` surface plus verbs is a genuinely clean API. Keep it.
- The laws section and the honest "When Quark Should Lose" / "What the Benchmark Does Not Prove" framing are correct and rare. Preserve that tone.
- The experimental boundary (only the row owner changes; `DataProvider`, reduction rules, and `SessionRowView` untouched) is right. Do not widen it while acting on these items.
- Duplicate-key preflight before any mutation (no partial updates) is correct; keep it.

## Suggested execution order

1. Check in benchmark + adverse workloads (items 1, 2)
2. Cheap key extraction, re-measure (item 4)
3. Unify grouping engines (item 5)
4. Counters + deterministic drive trace (item 7)
5. Decide the `values`/boundaries O(N) question with data (item 3)
6. Repartition filtering (item 6)
7. Recording artifact + doc corrections + polish (items 8, 9)
