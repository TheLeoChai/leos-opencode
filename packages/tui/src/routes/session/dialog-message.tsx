import { createMemo } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { PromptInfo } from "../../component/prompt/history"
import { stripPromptPartIDs as strip } from "../../prompt/part"
import type { Message, Part } from "@opencode-ai/sdk/v2"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  isDiveInTrack?: boolean
  isV2Message?: (messageID: string) => boolean
  messages?: () => Message[]
  parts?: (messageID: string) => Part[]
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() =>
    (props.messages?.() ?? sync.data.message[props.sessionID] ?? []).find((x) => x.id === props.messageID),
  )
  const route = useRoute()
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            const request = props.isDiveInTrack && props.isV2Message?.(msg.id)
              ? sdk.client.v2.session.revert
                  .stage({ sessionID: props.sessionID, messageID: msg.id })
                  .then(() => sync.session.sync(props.sessionID, { force: true }))
              : sdk.client.session.revert({ sessionID: props.sessionID, messageID: msg.id })
            void request

            if (props.setPrompt) {
              const parts = props.parts?.(msg.id) ?? sync.data.part[msg.id] ?? []
              const promptInfo = parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = props.parts?.(msg.id) ?? sync.data.part[msg.id] ?? []
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? (props.parts?.(msg.id) ?? sync.data.part[msg.id] ?? []).reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
