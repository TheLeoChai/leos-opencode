import { createMemo, onMount } from "solid-js"
import { useSync } from "../../context/sync"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import type { Message, Part } from "@opencode-ai/sdk/v2"

export function DialogTimeline(props: {
  sessionID: string
  isDiveInTrack?: boolean
  isV2Message?: (messageID: string) => boolean
  messages?: () => Message[]
  parts?: (messageID: string) => Part[]
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const dialog = useDialog()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = props.messages?.() ?? sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (props.parts?.(message.id) ?? sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => (
            <DialogMessage
              messageID={message.id}
              sessionID={props.sessionID}
              isDiveInTrack={props.isDiveInTrack}
              isV2Message={props.isV2Message}
              messages={props.messages}
              parts={props.parts}
              setPrompt={props.setPrompt}
            />
          ))
        },
      })
    }
    result.reverse()
    return result
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Timeline" options={options()} />
}
