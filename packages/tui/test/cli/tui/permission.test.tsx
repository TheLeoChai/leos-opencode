/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { OpenCodeEvent, PermissionV2Request } from "@opencode-ai/client"
import { createEffect, type ParentProps } from "solid-js"
import { ClientProvider, useClient } from "../../../src/context/client"
import { DataProvider as DataProviderBase, useData } from "../../../src/context/data"
import { LocationProvider, useLocation } from "../../../src/context/location"
import { usePermissionInput } from "../../../src/routes/session/permission"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function SyncLocation() {
  const data = useData()
  const location = useLocation()
  createEffect(() => location.set(data.location.default()))
  return null
}

function DataProvider(props: ParentProps) {
  return (
    <DataProviderBase>
      <LocationProvider>
        <SyncLocation />
        {props.children}
      </LocationProvider>
    </DataProviderBase>
  )
}

function emitEvent(events: ReturnType<typeof createEventStream>, event: OpenCodeEvent) {
  events.emit({ ...event, location: { directory } })
}

test("permission input tracks the tool part slot as input settles", async () => {
  const events = createEventStream()
  const sessionID = "session-permission-input"
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
  }, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>
  let input!: () => unknown

  const request = {
    id: "perm_1",
    sessionID,
    permission: "shell",
    resources: [],
    metadata: {},
    source: { messageID: "message-assistant", callID: "call-permission" },
    time: { created: 1 },
  } as unknown as PermissionV2Request

  function Probe() {
    data = useData()
    client = useClient()
    // Mounted like the permission dialog: before the tool call has settled.
    input = usePermissionInput(request)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))

  try {
    await wait(() => client.connection.status() === "connected")
    expect(input()).toEqual({})

    emitEvent(events, {
      id: "evt_perm_tool_started",
      created: 1,
      type: "session.tool.input.started",
      durable: { aggregateID: `session_${sessionID}`, seq: 0, version: 1 },
      data: { sessionID, assistantMessageID: "message-assistant", callID: "call-permission", name: "shell" },
    } as unknown as OpenCodeEvent)
    emitEvent(events, {
      id: "evt_perm_tool_called",
      created: 2,
      type: "session.tool.called",
      durable: { aggregateID: `session_${sessionID}`, seq: 1, version: 1 },
      data: {
        sessionID,
        assistantMessageID: "message-assistant",
        callID: "call-permission",
        input: { command: "rm -rf ./dist" },
        timestamp: 2,
      },
    } as unknown as OpenCodeEvent)

    // The prompt is already mounted; the resolved input must flow through the
    // part slot once the tool call settles out of input streaming.
    await wait(() => {
      const value = input()
      return typeof value === "object" && value !== null && (value as { command?: string }).command === "rm -rf ./dist"
    })
  } finally {
    app.renderer.destroy()
  }
})
