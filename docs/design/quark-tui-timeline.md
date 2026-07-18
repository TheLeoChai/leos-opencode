# Quark-Owned TUI Timeline Rows

Status: experiment in progress

## Summary

The V2 TUI previously stored its rendered session-row list in a Solid Store.
This experiment changes only that owner: `SessionTimeline` stores an ordered
array of stable row slots in a compiled Quark collection. Each slot owns one
`SessionRow`, and an owner-aware adapter exposes both levels to the existing
Solid renderer.

The event protocol, durable session data, `DataProvider`, row reduction rules,
and `SessionRowView` remain unchanged. This boundary makes the experiment easy
to compare and easy to remove. Message content remains in `DataProvider`;
`SessionTimeline` owns a finite imperative index of part IDs for its current
rows.

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
createSessionRows adapter
    |
    v
SessionTimeline
    |
    v
Layout.collection<SessionRow>
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

| Component                                     | Responsibility                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/tui/src/context/data.tsx`           | Preserve the existing server-event projection and message lookup API.                              |
| `packages/tui/src/routes/session/rows.ts`     | Translate DataProvider state and events into timeline operations; own the Solid adapter lifecycle. |
| `packages/tui/src/routes/session/timeline.ts` | Declare row layout, reduce snapshots, cache cursors, and implement timeline domain mutations.      |
| `packages/quark/src/layout.ts`                | Compile row keys/equivalence and maintain declared imperative collection indexes.                  |
| `packages/quark/src/reactivity.ts`            | Provide synchronous state updates, subscriptions, and transaction batching.                        |
| `packages/quark/src/keyed.ts`                 | Reuse per-key slots and separate value changes from structural changes.                            |
| `packages/quark/src/solid.ts`                 | Bridge Quark readables into Solid ownership and compose stable slots with `KeyedFor`.              |
| `packages/tui/src/routes/session/index.tsx`   | Render stable row accessors through `KeyedFor` and the existing `SessionRowView` components.       |
| `script/quark-timeline-drive.ts`              | Exercise the same streamed timeline scenario against baseline and fork binaries.                   |

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

`SessionTimeline` caches the first queued row ID and the active incomplete group
ID. Full replacement derives both once. Live operations maintain them as work
is queued or promoted. New assistant parts and completed messages insert before
the cached queue boundary; pending user inputs append after queued work; a
running compaction becomes the new boundary.

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
The event-native path now calls domain operations backed by the compiled
collection:

```text
group change       -> state.modify(groupID, update)
new row            -> state.insert(row, { before })
removed footer     -> state.remove(row.id)
full sync / revert -> state.set(nextRows)
```

Extending or completing a group creates one new group value with copied refs
and writes its existing slot. It does not copy unrelated groups or publish
structure. Permission repartitioning first checks whether a group's visible or
pending membership would actually change, then allocates arrays only for those
groups.

Message and footer duplicates use the keyed map. Part duplicates use the
compiled `parts` members index and return before aggregate projection. Unique
group appends use cached IDs and do not read `state.values()`. The append event
also supplies the exact one-member index delta, avoiding a scan of the growing
group; arbitrary replacements retain automatic index derivation.

## `Keyed` Preserves Row Identity

A full rebuild creates fresh row values, but Solid `<For>` uses item identity
to preserve child ownership. A changed group value must not remount its
`SessionRowView`, because that would reset the group's local expanded and hover
state. `<For>` therefore receives stable Quark slots rather than row values.

`Keyed.set(nextRows)` preserves ownership through its persistent key-to-slot
map:

```text
1. Validate the next keys.
2. Find each retained slot through the persistent map.
3. Update that slot only when generated row equivalence reports a change.
4. Reuse the previous outer slot array when membership and order are unchanged.
```

Every row receives one collision-safe length-prefixed primitive ID when it is
created. `SessionRowLayout` declares that key and generates discriminated-union
equivalence. Group `origin` is immutable metadata; `refs`, `pending`, and
`completed` participate in equivalence. Reconciliation performs no
serialization:

| Row               | ID shape                                               |
| ----------------- | ------------------------------------------------------ |
| Message           | `m{length}:{messageID}`                                |
| Queued compaction | `c{length}:{inputID}`                                  |
| Part              | `p{message segment}{part segment}`                     |
| Assistant footer  | `f{length}:{messageID}`                                |
| Group             | `g{kind}{origin message segment}{origin part segment}` |

Every group records the ref that created it as immutable `origin` metadata.
Appending refs, completing the group, and moving refs between permission
partitions cannot change its ID or boundary identity. Group equivalence compares
`completed`, every `refs` entry, and every exploration `pending` entry.

`Keyed` publishes two readables. `slots` changes only when key membership or
order changes, so Solid `<For>` does no structural work for a group-value
update. `values` depends on both the outer list and every slot for consumers
that require aggregate values. The TUI has no reactive `values` subscriber; it
uses the lazy aggregate for bulk permission repartitioning and snapshot/test
consumers.
Message boundaries track structural slots and messages, then read immutable
row identity fields untracked. A changed group publishes through its existing
slot and preserves the mounted Solid owner without recalculating boundaries.
The lazy aggregate is read by permission repartitioning and snapshot/test
consumers, not by unique append paths.

Slot updates and the outer-array update run inside both a Quark transaction and
a Solid batch. The Quark transaction settles the alien-signals graph; the
surrounding Solid batch holds adapter writes until every Quark listener has
flushed. Solid therefore observes one settled state rather than a row value
from one ordering and an outer slot array from another.

## Complexity Is Linear in Rows and Contained Refs

Let `R` be visible rows, `M` loaded messages, `P` assistant content parts, and
`C` the total refs contained by visible groups.

| Operation                    |                     Time |                                     Allocation |
| ---------------------------- | -----------------------: | ---------------------------------------------: |
| Full rebuild                 |           `O(M + P + R)` |       New reduction plus reconciled slot array |
| Active group / queue lookup  |          Expected `O(1)` |                                           None |
| Queue boundary advancement   |                   `O(R)` |                                           None |
| Group extension              |                   `O(G)` |     One copied group array; `O(1)` index delta |
| Structural insertion/removal |                   `O(R)` |                     One structural slots array |
| Duplicate part append        |                   `O(1)` |                                 One key string |
| Duplicate message/footer     |                   `O(1)` |                                 One key string |
| Footer removal               |                   `O(R)` |                      One structural slot array |
| Permission repartition       |               `O(R + C)` |       Arrays only for groups whose split moves |
| Quark-to-Solid publication   | `O(1)` per changed level | One slot write and, when required, outer write |

`Keyed.has` handles message and footer membership through the collection's
existing key map. `Layout.collection` maintains every visible part ID,
including refs nested inside groups. Full replacement rebuilds the finite index;
inserts and arbitrary modifications derive membership automatically; the hot
group append applies one typed member delta. Duplicate streaming deltas return
before reading the lazy aggregate or scanning rows.

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

Seven baseline/fork behavior pairs completed successfully:

|                   Pair |  Baseline | Quark fork | Fork / baseline |
| ---------------------: | --------: | ---------: | --------------: |
|                      1 | 11,505 ms |   6,455 ms |          0.561x |
|                      2 |  4,003 ms |   4,733 ms |          1.182x |
|          3, fork first |  9,296 ms |   7,563 ms |          0.813x |
|      4, API assertions |  4,283 ms |   3,114 ms |          0.727x |
| 5, current `origin/v2` |  3,636 ms |   2,074 ms |          0.570x |
|   6, current Drive API |  2,233 ms |   1,413 ms |          0.633x |
| 7, timeline extraction |    973 ms |     825 ms |          0.848x |

The range is too wide to support a speed claim. These runs establish that the
same streamed scenario renders and terminates on both implementations. They do
not establish that either implementation is faster.

## Validation Status

| Check                          | Current result                                                             |
| ------------------------------ | -------------------------------------------------------------------------- |
| TUI package typecheck          | Pass                                                                       |
| Full TUI test suite            | 274 pass, 1 skip                                                           |
| Focused data and row tests     | 55 pass                                                                    |
| Vendored Quark tests           | 24 pass                                                                    |
| Shared drive scripts typecheck | Pass                                                                       |
| Shared Drive behavior          | Seven baseline/fork pairs pass; latest pair verifies projected content     |
| Publication-counter trace      | Pass; exact slot/structure deltas recorded in performance model            |
| Paired performance evidence    | Pass for controlled workloads; end-to-end wall time remains non-conclusive |

## Reactive Query Caches Remain Outside This Phase

The timeline's imperative members index is finite: entries follow current rows
and are removed synchronously. It is not a reactive query cache and renderers
do not subscribe to it.

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
