import { Effect } from "effect"
import { defineScript, Llm } from "opencode-drive"

const marker = "QUARK_TIMELINE_COMPLETE"
const reasoning = Array.from(
  { length: 16 },
  (_, index) => `Reasoning segment ${index + 1} checks streamed timeline updates.`,
).join(" ")
const response = `${Array.from(
  { length: 24 },
  (_, index) => `Timeline chunk ${index + 1} remains visible and ordered.`,
).join(" ")} ${marker}`

export default defineScript({
  project: {
    git: true,
    files: {
      "src/example.ts": "export const timeline = true\n",
    },
  },
  tui: { viewport: { cols: 120, rows: 36 } },
  run: ({ opencode, llm, ui }) =>
    Effect.gen(function* () {
      yield* ui.waitFor((state) => state.focused.editor)
      yield* llm.title(() => Effect.succeed("Timeline comparison"))
      const started = Date.now()
      yield* ui.submit("Explain how this project handles its timeline.")
      yield* llm.send(
        Llm.reasoning(reasoning, { delay: 1, chunkSize: 8 }),
        Llm.text(response, { delay: 1, chunkSize: 8 }),
      )
      yield* ui.waitFor(marker, { timeout: 30_000 })
      const session = (yield* opencode.session.list({})).data[0]
      if (!session) throw new Error("the Drive session was not projected")
      const assistant = (yield* opencode.message.list({ sessionID: session.id })).data.findLast(
        (message) => message.type === "assistant",
      )
      if (assistant?.type !== "assistant") throw new Error("the assistant message was not projected")
      if (!assistant.content.some((part) => part.type === "reasoning" && part.text === reasoning))
        throw new Error("the projected reasoning content did not match")
      if (!assistant.content.some((part) => part.type === "text" && part.text === response))
        throw new Error("the projected text content did not match")
      if (assistant.finish !== "stop") throw new Error("the projected assistant message did not finish")
      yield* Effect.sync(() => console.log(`METRIC tui_timeline_drive_ms=${Date.now() - started}`))
    }),
})
