import "./offline.ts"
import { expect, test } from "bun:test"
import { ProxyAi } from "../../src/remote/proxy-ai.ts"
import * as attach from "../../src/server/attach.ts"
import * as daemon from "../../src/server/daemon.ts"
import * as discovery from "../../src/server/discovery.ts"
import * as errors from "../../src/server/errors.ts"
import * as idle from "../../src/server/idle.ts"
import * as linuxPeer from "../../src/server/linux-peer.ts"
import * as platform from "../../src/server/platform.ts"
import * as endpoint from "../../src/server/socket-endpoint.ts"

test("daemon modules expose only host adapters, not extension API or wire state", () => {
  expect({
    attach: Object.keys(attach).sort(),
    daemon: Object.keys(daemon).sort(),
    discovery: Object.keys(discovery),
    endpoint: Object.keys(endpoint).sort(),
    errors: Object.keys(errors).sort(),
    linuxPeer: Object.keys(linuxPeer),
    idle: Object.keys(idle),
    platform: Object.keys(platform).sort(),
    reconnectSettings: typeof ProxyAi.prototype.setReconnectTimeout,
  }).toMatchInlineSnapshot(`
    {
      "attach": [
        "attachWorkspace",
        "relayBytes",
        "stopWorkspace",
      ],
      "daemon": [
        "ensureWorkspaceDaemon",
        "openWorkspaceDaemon",
        "startWorkspaceDaemon",
      ],
      "discovery": [
        "DaemonDiscovery",
      ],
      "endpoint": [
        "assertDaemonPeer",
        "socketEndpoint",
      ],
      "errors": [
        "DaemonIncompatibilityError",
        "daemonAttachFault",
      ],
      "idle": [
        "IdleDeadline",
      ],
      "linuxPeer": [
        "readLinuxPeer",
      ],
      "platform": [
        "LinuxDaemonPlatform",
        "socketIO",
      ],
      "reconnectSettings": "function",
    }
  `)
})
