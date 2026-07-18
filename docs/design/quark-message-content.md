# Quark-Owned Message Content Slots

Status: implemented; drive parity pending

## Summary

Assistant message content currently lives as unkeyed arrays inside the
DataProvider Solid store. Streaming deltas mutate those arrays through
`produce`, and every consumer that resolves a part re-scans `content`
(`findLast`, `filter(type)[ordinal]`), so per-delta work scales with message
size instead of delta size.

This experiment changes only content ownership: each assistant message's parts
become one Quark keyed collection with stable per-part slots. Streaming events
already name the slot on the wire — `ordinal` for text and reasoning, `callID`
for tools — so deltas address slots directly instead of being rediscovered.

Message metadata (finish, usage, retry, error), the event protocol, timeline
rows, and view components' rendering logic remain unchanged.

The experiment succeeds only if all checks pass:

1. Existing TUI data and row tests preserve their behavior.
2. Per-delta work is O(1) in message size: one slot publication per delta,
   zero structural publications, one markdown recompute scoped to the part.
3. The drive script passes unchanged.

## Ownership Boundary

```
server events
    |
    v
DataProvider
    ├── Solid store: session/message metadata (unchanged)
    └── SessionContent: Keyed<Part> per assistant message   <- this experiment
              |                        |
              | slots (structure)      | slot (value channel)
              v                        v
       part row resolution      TextPart / ReasoningPart / ToolPart
```

- Part identity: `text:{ordinal}` and `reasoning:{ordinal}` from event
  ordinals, tool parts by `callID`. These match the synthetic part IDs the
  timeline already uses, so `resolvePart`'s positional bridge disappears.
- Deltas are value-channel publications: `content.modify(key, ...)`. The
  parts `<For>`/group structure never re-runs on a delta.
- Part starts are structural insertions; `ended` events publish the
  authoritative final value into the same slot.
- Full sync (`message.sync`) seeds each message's collection with `set(parts)`
  derived from the fetched payload, assigning ordinals per type in order.
- Revert, session removal, and model-switch refetch drop or reseed collections.
- Cold consumers (transcript export, copy-last-response, message navigation,
  permission lookup) read `values()` — plain arrays, same shapes as before.

## Part Layout

Tool identity fields are immutable; streamed fields are mutable. The field
diff mask means a tool status change skips text-driven work and vice versa.

```ts
const PartLayout = Layout.keyedUnion({
  key: Layout.key("partID", Layout.string),
  tag: "type",
  variants: {
    text: Layout.struct({ text: Layout.string }),
    reasoning: Layout.struct({ text: Layout.string, state: ..., time: ... }),
    tool: Layout.struct({
      id: Layout.immutable(Layout.string),
      name: Layout.immutable(Layout.string),
      state: ..., time: ..., executed: ..., providerState: ...,
    }),
  },
})
```

Store values are the client `SessionMessageAssistant*` content shapes plus the
synthetic `partID`; `values()` strips nothing because consumers already ignore
unknown fields.

## What Is Not In Scope

- Message metadata stays in the Solid store.
- No changes to server events or the client package types.
- No lazy or pull-based consumers; slots publish eagerly as today.
- Timeline row ownership is the previous experiment and is unchanged.

## Measurement

Instrument with `Keyed.Metrics`: a streaming test drives N deltas into a
message with M existing parts and asserts slot publications == N and
structural publications == parts started, independent of M. Markdown
recompute counts are asserted through the part component render counters in
the existing test harness.
