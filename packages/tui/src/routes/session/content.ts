import type { SessionMessageAssistant } from "@opencode-ai/client"
import { Keyed, Layout } from "effect-quark"

/**
 * Stable per-part reactive slots for assistant message content.
 *
 * Streaming events name their part on the wire (text/reasoning by ordinal,
 * tools by callID); each assistant message owns one keyed collection so a
 * delta publishes exactly one slot instead of reconciling a content array.
 * Design record: quark repo, docs/experiments/quark-message-content.md.
 */
export namespace SessionContent {
  type ContentPart = SessionMessageAssistant["content"][number]
  export type Part = ContentPart & { readonly partID: string }
  export type Parts = Keyed.Keyed<Part, string>

  // Streamed sub-objects are replaced immutably on change, so reference
  // equality is the correct (and cheapest) field comparator for them.
  const reference: Layout.Field<unknown> = { equivalent: Object.is }

  const PartLayout = Layout.keyedUnion({
    key: Layout.key("partID", Layout.string),
    tag: "type",
    variants: {
      text: Layout.struct({ text: Layout.string }),
      reasoning: Layout.struct({ text: Layout.string, state: reference, time: reference }),
      tool: Layout.struct({
        id: Layout.immutable(Layout.string),
        name: Layout.immutable(Layout.string),
        executed: reference,
        providerState: reference,
        providerResultState: reference,
        state: reference,
        time: reference,
      }),
    },
  })
  // The layout describes the reactive fields of the client content shapes;
  // the plan is typed against those shapes at this single boundary.
  const PartPlan = Layout.compile(PartLayout) as unknown as Layout.Plan<Part, string>

  export function textID(ordinal: number) {
    return `text:${ordinal}`
  }

  export function reasoningID(ordinal: number) {
    return `reasoning:${ordinal}`
  }

  /** Assign the synthetic part IDs used across the TUI to a fetched content array. */
  export function withPartIDs(content: readonly ContentPart[]): Part[] {
    const ordinals = { text: 0, reasoning: 0 }
    return content.map((part) => {
      if (part.type === "tool") return { ...part, partID: part.id }
      return { ...part, partID: `${part.type}:${ordinals[part.type]++}` }
    })
  }

  export function make(options?: { readonly metrics?: Keyed.Metrics }) {
    const collections = new Map<string, Parts>()
    const id = (sessionID: string, messageID: string) => `${sessionID}\u0000${messageID}`

    return {
      get(sessionID: string, messageID: string) {
        return collections.get(id(sessionID, messageID))
      },
      ensure(sessionID: string, messageID: string) {
        const key = id(sessionID, messageID)
        const existing = collections.get(key)
        if (existing) return existing
        const created = PartPlan.make([], options)
        collections.set(key, created)
        return created
      },
      seed(sessionID: string, messageID: string, content: readonly ContentPart[]) {
        this.ensure(sessionID, messageID).set(withPartIDs(content))
      },
      /** Drop one message's collection, or every collection for a session. */
      drop(sessionID: string, messageID?: string) {
        if (messageID !== undefined) {
          collections.delete(id(sessionID, messageID))
          return
        }
        const prefix = `${sessionID}\u0000`
        for (const key of [...collections.keys()]) {
          if (key.startsWith(prefix)) collections.delete(key)
        }
      },
      /**
       * Drop collections for messages absent from a refetched snapshot.
       * Present messages must be reseeded in place, never dropped: mounted
       * views hold their collection reference for their whole lifetime, so
       * replacing the object would orphan their subscriptions.
       */
      prune(sessionID: string, keep: ReadonlySet<string>) {
        const prefix = `${sessionID}\u0000`
        for (const key of [...collections.keys()]) {
          if (key.startsWith(prefix) && !keep.has(key.slice(prefix.length))) collections.delete(key)
        }
      },
    }
  }
}
