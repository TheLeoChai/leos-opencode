import { expect, test } from "bun:test"
import { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(ConfigProviderV1.Model)

test("accepts known and custom interleaved reasoning fields", () => {
  const fields = ["reasoning", "reasoning_content", "reasoning_text", "reasoning_details", "vendor_reasoning"]

  for (const field of fields) expect(decode({ interleaved: { field } }).interleaved).toEqual({ field })
})
