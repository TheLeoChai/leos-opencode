# Quark-Owned TUI Timeline Rows

Status: experiment in progress

## Summary

The V2 TUI currently stores its rendered session-row list in a Solid Store.
This experiment changes only that owner: `createSessionRows` stores an ordered
array of stable row slots in Quark state. Each slot owns one `SessionRow`, and
an owner-aware adapter exposes both levels to the existing Solid renderer.

The event protocol, durable session data, `DataProvider`, row reduction rules,
and `SessionRowView` remain unchanged. This boundary makes the experiment easy
to compare and easy to remove. It does not yet move messages or secondary
indexes into Quark collections.

The experiment succeeds only if all three checks pass:

1. Existing TUI timeline tests preserve their behavior.
2. One `opencode-drive` script passes unchanged against untouched `origin/v2`
   and this branch.
3. The Quark path improves measured timeline work without increasing visible
   latency or invalidation counts.

## The Row Owner Is the Experimental Boundary

`DataProvider` receives server events and projects them into its existing Solid
Store. `createSessionRows` reads that projection, subscribes to timeline events,
and maintains the ordered rows consumed by `SessionRowView`.

Before this branch, `createSessionRows` also used a Solid Store for its row
state:

```text
server events
    |
    v
DataProvider Solid Store
    |
    v
createSessionRows
    |
    v
SessionRow[] Solid Store
    |
    v
<For> -> SessionRowView
```

This branch replaces only the second store:

```text
server events
    |
    v
DataProvider Solid Store
    |
    v
createSessionRows
    |
    v
Quark State<RowSlot[]>
    |
    v
KeyedFor outer + slot adapters
    |
    v
SessionRowView
```

The narrow boundary answers one question: does Quark improve the TUI timeline
when it owns the ordered render rows? Moving message storage at the same time
would make a regression or improvement impossible to attribute.

## Components and Responsibilities

| Component                                   | Responsibility                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/tui/src/context/data.tsx`         | Preserve the existing server-event projection and message lookup API.                               |
| `packages/tui/src/routes/session/rows.ts`   | Reduce loaded messages, apply incremental timeline events, and own ordered rows.                    |
| `packages/quark/src/reactivity.ts`          | Provide synchronous state updates, subscriptions, and transaction batching.                         |
| `packages/quark/src/keyed.ts`               | Reuse per-key slots and separate value changes from structural changes.                             |
| `packages/quark/src/solid.ts`               | Bridge Quark readables into Solid ownership and compose stable slots with `KeyedFor`.               |
| `packages/tui/src/routes/session/index.tsx` | Render stable row accessors through `KeyedFor` and the existing `SessionRowView` components.        |
| `script/quark-timeline-drive.ts`            | Exercise the same streamed timeline scenario against baseline and fork binaries.                    |

## Quark State Publishes One Synchronous Value

`State.make(initial)` wraps an `alien-signals` signal with three operations:

```ts
read() // track and return the current value
read.set(next) // publish one replacement value
read.update(f) // derive and publish from the current value
```

`subscribe` creates an `alien-signals` effect. The effect reads the signal once
to establish its dependency without calling the listener, because `useValue`
already reads the initial value. Later signal writes rerun the effect
synchronously and call the listener once with the published value.

Before invoking the listener, `subscribe` clears alien-signals' active
subscriber and restores it afterward. Reads performed by the listener or by a
synchronous Solid update therefore cannot become accidental dependencies of
the Quark subscription.

Transactions call `startBatch()` and `endBatch()`. Row reconciliation can
update several slots plus the outer slot array, so the row owner uses one
transaction for the complete publication.

## `useValue` Crosses the Reactive Boundary Once

`useValue(readable)` creates one Solid signal initialized from `readable()`. It
then subscribes to Quark and forwards each published value into that Solid
signal. The timeline uses this algorithm for the structural slot list and each
mounted row slot. Its aggregate `values` readable remains inside Quark and is
not mirrored into Solid:

```text
outer Quark State.set(nextSlots)
          |
          v
alien-signals subscription
          |
          v
Solid setSignal(nextSlots)
          |
          v
rowSlots() -> <For>
                    |
                    v
             slot Quark State.set(nextRow)
                    |
                    v
             row() -> SessionRowView
```

The adapter passes `() => nextRows` to Solid's setter. Solid treats a bare
function as an updater, so the wrapper is required when the reactive value
itself could be a function. The same generic adapter therefore works for both
arrays and callable values.

## Full Rebuilds Use a Deterministic Reducer

Connection, synchronization, revert, pending-compaction, and message-boundary
changes rebuild rows from the current `DataProvider` projection. The rebuild
algorithm is:

```text
messages = loaded messages before the revert boundary
inputs = admitted input message IDs
pending = running compaction IDs + input IDs

ordered messages =
  completed messages
  + running compactions
  + admitted inputs

for each ordered message:
  non-assistant -> append one message row
  assistant     -> append/group each non-empty content part
  finished assistant -> append one footer row

partition exploration refs by pending permission call IDs
insert queued compactions before the first pending input row
```

The first partition puts completed transcript rows before work that has not
crossed its safe execution boundary. A non-pending message completes the group
immediately before it. This prevents reasoning or exploration groups from
visually spanning separate transcript messages.

Assistant text and reasoning parts use their ordinal among parts of the same
type as their stable part ID, such as `text:0` or `reasoning:1`. Tool parts use
their call ID. Empty text and reasoning parts do not create rows.

## Incremental Events Avoid Full Reduction

Most live events update the current row array directly:

| Event shape                                                     | Row operation                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| New user, synthetic, shell, model, agent, or compaction message | Insert a message row unless its ID already exists.              |
| First non-empty text or reasoning delta                         | Insert or extend the corresponding part/group row.              |
| Tool input started                                              | Insert a tool row or extend an exploration group.               |
| Step ended, failed, or retry scheduled                          | Insert an assistant footer.                                     |
| Step started                                                    | Remove the previous retry footer.                               |
| Permission changed                                              | Repartition exploration refs between visible and pending lists. |

`queuedStart(rows)` finds the first queued compaction or pending message. New
assistant parts and completed messages insert before that boundary. Pending
user inputs append after queued work. A running compaction inserts at the start
of the queued region.

`append(rows, ref, part, index)` implements grouping:

```text
reasoning part:
  extend the immediately preceding reasoning group
  or complete the preceding group and create a reasoning group

read/glob/grep tool:
  extend the immediately preceding exploration group
  or complete the preceding group and create an exploration group

other text or tool part:
  complete the preceding group and insert a standalone part row
```

The grouping decision depends on the tool name, not the call ID. This matters
because call IDs can look like generated text or reasoning IDs.

## Incremental Mutations Touch Only Affected Slots

The old Solid `produce` path created a mutable draft of the row list. The first
Quark implementation also rebuilt a complete next array, then reconciled it.
The event-native path now uses the information already present in each event:

```text
value change       -> Keyed.update(row)
new row            -> Keyed.insert(row, { before })
removed footer     -> Keyed.remove(row.id)
full sync / revert -> Keyed.set(nextRows)
```

Extending or completing a group creates one new group value with copied refs
and writes its existing slot. It does not copy unrelated groups or publish
structure. Permission repartitioning first checks whether a group's visible or
pending membership would actually change, then allocates arrays only for those
groups.

Duplicate message, part, or footer events return before a Keyed operation.
Same-ordinal streaming deltas therefore produce no slot or structural
publication after the first part.

## `Keyed` Preserves Row Identity

A full rebuild creates fresh row values, but Solid `<For>` uses item identity
to preserve child ownership. A changed group value must not remount its
`SessionRowView`, because that would reset the group's local expanded and hover
state. `<For>` therefore receives stable Quark slots rather than row values.

`Keyed.set(nextRows)` preserves ownership in four passes:

```text
1. Index previous slots by the semantic key of their current row.
2. For each next row, find the previous slot with that key.
3. Update that slot only when the rendered row fields changed.
4. Reuse the previous outer slot array when membership and order are unchanged.
```

Every row receives one collision-safe length-prefixed primitive ID when it is
created. `Keyed` reads `row.id`; reconciliation performs no serialization:

| Row               | ID shape                                              |
| ----------------- | ----------------------------------------------------- |
| Message           | `m{length}:{messageID}`                               |
| Queued compaction | `c{length}:{inputID}`                                 |
| Part              | `p{message segment}{part segment}`                    |
| Assistant footer  | `f{length}:{messageID}`                               |
| Group             | `g{kind}{origin message segment}{origin part segment}` |

Every group records the ref that created it as immutable `origin` metadata.
Appending refs, completing the group, and moving refs between permission
partitions cannot change its ID or boundary identity. Group equivalence compares
`completed`, every `refs` entry, and every exploration `pending` entry.

`Keyed` publishes two readables. `slots` changes only when key membership or
order changes, so Solid `<For>` does no structural work for a group-value
update. `values` depends on both the outer list and every slot for consumers
that require aggregate values. The TUI has no reactive `values` subscriber; it
uses the lazy aggregate only as an internal snapshot for unique mutation paths.
Message boundaries track structural slots and messages, then read immutable
row identity fields untracked. A changed group publishes through its existing
slot and preserves the mounted Solid owner without recalculating boundaries.

Slot updates and the outer-array update run inside both a Quark transaction and
a Solid batch. The Quark transaction settles the alien-signals graph; the
surrounding Solid batch holds adapter writes until every Quark listener has
flushed. Solid therefore observes one settled state rather than a row value
from one ordering and an outer slot array from another.

## Complexity Is Linear in Rows and Contained Refs

Let `R` be visible rows, `M` loaded messages, `P` assistant content parts, and
`C` the total refs contained by visible groups.

| Operation                  |                     Time |                                      Allocation |
| -------------------------- | -----------------------: | ----------------------------------------------: |
| Full rebuild               |           `O(M + P + R)` |        New reduction plus reconciled slot array |
| Unique incremental append  |               `O(R + C)` | One structural array or one changed group array |
| Duplicate part append      |                   `O(1)` |                                            None |
| Duplicate message/footer   |                   `O(1)` |                                            None |
| Footer removal             |                   `O(R)` |                       One structural slot array |
| Permission repartition     |               `O(R + C)` |        Arrays only for groups whose split moves |
| Quark-to-Solid publication | `O(1)` per changed level |  One slot write and, when required, outer write |

`Keyed.has` handles message and footer membership through the collection's
existing key map. A route-scoped `Set` contains every visible part ID, including
refs nested inside groups. Full rebuilds repopulate it and unique appends add to
it once. Duplicate streaming deltas therefore return before reading the lazy
aggregate or scanning rows. Unique appends still materialize the current row
snapshot and scan for the queued boundary; that lower-frequency path remains
linear deliberately rather than introducing a secondary-index layer.

## Solid Owns the Adapter Lifecycle

`createSessionRows` runs inside the Solid owner for the session route.
`useValue` reads the initial Quark value, subscribes once, and registers the
unsubscribe function with Solid's `onCleanup`.

The existing event-bus subscriptions use the same owner cleanup. Leaving the
route therefore removes both the Quark-to-Solid subscription and all timeline
event subscriptions. Quark state does not outlive the route.

## Behavior Must Remain Equivalent

The experiment preserves these existing timeline rules:

- User, synthetic, compaction, shell, model, and agent messages retain their
  current ordering.
- Pending inputs and queued compactions remain after active output.
- Reasoning and exploration parts retain their grouping behavior.
- Exploration tool calls move between pending and completed partitions when
  permissions change.
- Retry footers appear and disappear on the same events.
- Duplicate message, part, and footer events remain idempotent.
- Revert boundaries and message synchronization still rebuild the complete row
  list from `DataProvider`.
- `SessionRowView` continues to resolve message content from `DataProvider`;
  Quark owns row structure, not message content.

Changing `createSessionRows` from an array-like Solid Store to structural
`slots` plus an internal lazy aggregate is an internal API change. The session
route and its data-test probes are the only consumers on this branch.

## The Comparison Uses One Drive Script

The baseline is a detached worktree at
`/Users/kit/code/open-source/opencode-quark-baseline`, pinned to the same
`origin/v2` commit as the fork. The fork is
`/Users/kit/code/open-source/opencode-quark-timeline`.

`script/quark-timeline-drive.ts` creates one isolated project, submits one
prompt, streams one long reasoning span and one long text span as many delta
events, and waits for the final `QUARK_TIMELINE_COMPLETE` marker. The script
prints elapsed wall time and uses marker visibility as its rendered correctness
assertion. This workload stresses duplicate-part handling after the first
delta; it does not create 120 distinct timeline rows.

After the marker renders, the script queries the same isolated service and
asserts that the projected assistant message contains the complete reasoning
span, complete text span, and `stop` finish. The API assertion covers content
that has scrolled outside the terminal viewport.

Run the same checked script against each worktree:

```sh
cd /Users/kit/code/open-source/opencode-drive

packages/drive/bin/opencode-drive check \
  /Users/kit/code/open-source/opencode-quark-timeline/script/quark-timeline-drive.ts

packages/drive/bin/opencode-drive start \
  --name quark-timeline-baseline \
  --script /Users/kit/code/open-source/opencode-quark-timeline/script/quark-timeline-drive.ts \
  --dev /Users/kit/code/open-source/opencode-quark-baseline

packages/drive/bin/opencode-drive start \
  --name quark-timeline-fork \
  --script /Users/kit/code/open-source/opencode-quark-timeline/script/quark-timeline-drive.ts \
  --dev /Users/kit/code/open-source/opencode-quark-timeline
```

Wall time from one end-to-end drive run is supporting evidence, not a stable
microbenchmark. Provider simulation, terminal polling, and process scheduling
also contribute to it. A performance decision requires repeated paired runs
and row-update or invalidation counters in addition to this behavioral check.

Three alternating smoke pairs completed successfully:

|                   Pair |  Baseline | Quark fork | Fork / baseline |
| ---------------------: | --------: | ---------: | --------------: |
|                      1 | 11,505 ms |   6,455 ms |          0.561x |
|                      2 |  4,003 ms |   4,733 ms |          1.182x |
|          3, fork first |  9,296 ms |   7,563 ms |          0.813x |
|      4, API assertions |  4,283 ms |   3,114 ms |          0.727x |
| 5, current `origin/v2` |  3,636 ms |   2,074 ms |          0.570x |
| 6, current Drive API   |  2,233 ms |   1,413 ms |          0.633x |

The range is too wide to support a speed claim. These runs establish that the
same streamed scenario renders and terminates on both implementations. They do
not establish that either implementation is faster.

## Validation Status

| Check                                | Current result                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| TUI package typecheck                | Pass                                                                       |
| Full TUI test suite                  | 267 pass, 1 skip                                                           |
| Focused data and row tests           | 48 pass                                                                    |
| Vendored Quark tests                 | 13 pass                                                                    |
| Shared drive scripts typecheck       | Pass                                                                       |
| Shared Drive behavior                | Six baseline/fork pairs pass; latest pair verifies projected content       |
| Publication-counter trace            | Pass; exact slot/structure deltas recorded in performance model            |
| Paired performance evidence          | Pass for controlled workloads; end-to-end wall time remains non-conclusive |

## Collection Cache Growth Is Outside This Phase

The standalone `effect-quark` prototype includes reactive missing-key and
secondary-index query caches without eviction. This branch vendors only Quark
state and the Solid adapter; it does not create those caches.

A later message-collection phase must not delete empty cache entries while a
live readable still references them. Safe eviction therefore needs explicit
collection ownership or subscription reference counting. That design is not a
prerequisite for the route-scoped row-state experiment.

## Rollback Is One Seam

Rollback removes the private `effect-quark` workspace package and restores the
Solid Store in `createSessionRows`. No protocol, persisted data, public client
API, or server projection changes need migration.

The experiment should not expand into `DataProvider` message storage until the
current boundary has behavior parity and repeatable performance evidence.
