import { Effect, Stream } from "effect"
import { defineScript, Llm } from "opencode-drive"

const marker = "QUARK_GROUP_COMPLETE"

export default defineScript({
  project: {
    git: true,
    files: {
      "src/one.ts": "export const one = 1\n",
      "src/two.ts": "export const two = 2\n",
    },
  },
  config: {
    permissions: [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*one.ts", effect: "allow" },
    ],
  },
  tui: { viewport: { cols: 120, rows: 36 }, recording: true },
  run: ({ llm, ui }) =>
    Effect.gen(function* () {
      yield* ui.waitFor((state) => state.focused.editor)
      let attempt = 0
      yield* llm.serve(() => {
        const current = attempt++
        if (current === 0)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "call_read_one",
              name: "read",
              input: { path: "src/one.ts" },
            }),
            Llm.finish("tool-calls"),
          )
        if (current === 1)
          return Stream.make(
            Llm.toolCall({
              index: 0,
              id: "call_read_two",
              name: "read",
              input: { path: "src/two.ts" },
            }),
            Llm.finish("tool-calls"),
          )
        return Stream.make(Llm.text(marker), Llm.finish("stop"))
      })
      yield* ui.submit("Inspect both source modules, then finish.")
      yield* ui.waitFor("Permission required", { timeout: 15_000 })
      const frame = yield* ui.capture()
      const row = frame.lines.findIndex((line) => line.spans.some((span) => span.text.includes("Exploring")))
      if (row === -1) throw new Error("the exploration summary was not visible")
      const column = 8
      const candidates = (yield* ui.state()).elements.filter(
        (element) =>
          element.x <= column &&
          element.x + element.width > column &&
          element.y <= row &&
          element.y + element.height > row,
      )
      if (candidates.length === 0) throw new Error("the exploration summary had no renderable target")
      const summary = candidates.reduce((smallest, element) =>
        element.width * element.height < smallest.width * smallest.height ? element : smallest,
      )
      yield* ui.click(summary, { x: column - summary.x, y: row - summary.y })
      yield* ui.waitFor("src/one.ts")
      const before = yield* ui.screenshot("group-expanded-pending")
      yield* ui.enter()
      yield* ui.waitFor(marker, { timeout: 15_000 })
      yield* ui.waitFor("src/two.ts")
      const after = yield* ui.screenshot("group-expanded-complete")
      yield* Effect.sync(() => console.log(`ARTIFACT group_before=${before}`))
      yield* Effect.sync(() => console.log(`ARTIFACT group_after=${after}`))
    }),
})
