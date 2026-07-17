import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Message, ToolDefinition } from "../../src"
import * as OpenAICompatible from "../../src/providers/openai-compatible"
import * as OpenRouter from "../../src/providers/openrouter"
import { LLMClient } from "../../src/route"
import { recordedTests } from "../recorded-test"

const weather = ToolDefinition.make({
  name: "get_weather",
  description: "Get the weather for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
})

const openRouter = OpenRouter.configure({
  apiKey: process.env.OPENROUTER_API_KEY ?? "fixture",
  providerOptions: { openrouter: { reasoning: { max_tokens: 1024 } } },
}).model("anthropic/claude-sonnet-4.6")

const vercel = OpenAICompatible.configure({
  provider: "vercel-ai-gateway",
  baseURL: "https://ai-gateway.vercel.sh/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY ?? "fixture",
  http: { body: { reasoning: { enabled: true, max_tokens: 1024 } } },
}).model("anthropic/claude-sonnet-4.6")

const cases = [
  {
    name: "OpenRouter",
    model: openRouter,
    requires: ["OPENROUTER_API_KEY"],
    cassette: "openrouter-reasoning-details",
  },
  {
    name: "Vercel AI Gateway",
    model: vercel,
    requires: ["AI_GATEWAY_API_KEY"],
    cassette: "vercel-ai-gateway-reasoning-details",
  },
] as const

for (const item of cases) {
  const recorded = recordedTests({
    prefix: "openai-compatible-chat",
    provider: item.model.provider,
    protocol: "openai-chat",
    requires: item.requires,
    tags: ["reasoning", "reasoning-details", "continuation"],
    metadata: { model: item.model.id },
  })

  describe(`${item.name} reasoning details recorded`, () => {
    recorded.effect.with(
      "streams and preserves reasoning details",
      { cassette: item.cassette },
      () =>
        Effect.gen(function* () {
          const response = yield* LLMClient.generate(
            LLM.request({
              model: item.model,
              system: "Think through the arithmetic, then reply with only the final integer.",
              prompt: "What is 173 multiplied by 219?",
              generation: { maxTokens: 1536, temperature: 0 },
            }),
          )
          expect(response.text.replaceAll(",", "").trim()).toBe("37887")
          expect(response.reasoning.length).toBeGreaterThan(0)
          expect(response.events.some(LLMEvent.is.reasoningDelta)).toBe(true)
          const reasoning = response.message.content.find((part) => part.type === "reasoning")
          expect(reasoning?.providerMetadata?.openai?.reasoningField).toBe("reasoning")
          const details = reasoning?.providerMetadata?.openai?.reasoningDetails
          expect(Array.isArray(details)).toBe(true)
          expect(
            Array.isArray(details) &&
              details.some(
                (detail) =>
                  typeof detail === "object" &&
                  detail !== null &&
                  "type" in detail &&
                  detail.type === "reasoning.text" &&
                  "signature" in detail &&
                  typeof detail.signature === "string" &&
                  detail.signature.length > 0,
              ),
          ).toBe(true)

          const tool = yield* LLMClient.generate(
            LLM.request({
              model: item.model,
              system: "Call the requested tool exactly once.",
              messages: [
                Message.user("What is 173 multiplied by 219?"),
                response.message,
                Message.user("Call get_weather with city exactly Paris."),
              ],
              tools: [weather],
              generation: { maxTokens: 1536, temperature: 0 },
            }),
          )
          expect(tool.toolCalls).toMatchObject([{ name: "get_weather", input: { city: "Paris" } }])
        }),
      30_000,
    )
  })
}
