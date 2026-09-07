import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("both summary passes include prior canonical context and window-scaled targets", () => {
  const high = SessionCompaction.buildPrompt({
    pass: "high",
    window: 200_000,
    previousSummary: "Old rule",
    context: ["plugin context"],
  })
  const low = SessionCompaction.buildPrompt({
    pass: "low",
    window: 200_000,
    previousSummary: "Old rule",
    context: ["plugin context"],
  })
  for (const prompt of [high, low]) {
    expect(prompt).toContain("<previous-summary>\nOld rule\n</previous-summary>")
    expect(prompt).toContain("10000–20000")
    expect(prompt).toContain("plugin context")
    expect(prompt).not.toContain("{{")
  }
  expect(high).toContain("at least 6000")
  expect(high).toContain("superseded decisions")
  expect(high).toContain("still-valid rules")
  expect(low).toContain("9000 tokens")
  expect(low).toContain("Minimums are targets")
})

test("compaction config validates retention and trigger fractions in both schemas", () => {
  for (const value of [0, 1, -0.1, 1.1, NaN, Infinity]) {
    expect(() => Schema.decodeUnknownSync(ConfigCompaction.Info)({ keep_threshold: value })).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ compaction: { keep_threshold: value } })).toThrow()
  }
  for (const value of [0, -0.1, 1.1, NaN, Infinity]) {
    expect(() => Schema.decodeUnknownSync(ConfigCompaction.Info)({ threshold: value })).toThrow()
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ compaction: { threshold: value } })).toThrow()
  }
  expect(Schema.decodeUnknownSync(ConfigCompaction.Info)({ keep_threshold: 0.35, threshold: 0.75 })).toMatchObject({
    keep_threshold: 0.35,
    threshold: 0.75,
  })
  expect(Schema.decodeUnknownSync(ConfigCompaction.Info)({ threshold: 1 }).threshold).toBe(1)
})
