export * as Token from "./token"

const CHARS_PER_TOKEN = 4
const MEDIA_TOKENS = 8_000
const DATA_URL = /data:([^;,]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=_-]+)/g

export const estimate = (input: string) => {
  let media = 0
  const text = input.replace(DATA_URL, (_value, mime: string) => {
    media += MEDIA_TOKENS
    return `[attached ${mime}]`
  })
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN) + media)
}
