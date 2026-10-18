import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { FrontendOperations } from "@amira/core"
import * as codec from "../../src/remote/codec.ts"
import * as connection from "../../src/remote/connection.ts"
import * as errors from "../../src/remote/errors.ts"
import * as protocol from "../../src/remote/protocol.ts"
import * as writer from "../../src/remote/writer.ts"
import * as schema from "../../src/remote-schema.ts"
import type { ServerOperations } from "../../src/server/operations.ts"

// A host DTO operation cannot silently disappear from the finite wire allowlist.
const hostOperationsCovered: Exclude<
  keyof FrontendOperations | keyof ServerOperations,
  protocol.RemoteOperation
> extends never
  ? true
  : false = true

test("remote host modules keep an explicit export surface independent of legacy RPC", () => {
  expect(hostOperationsCovered).toBe(true)
  expect(Object.keys(protocol).sort()).toEqual([
    "REMOTE_LIMITS",
    "REMOTE_OPERATIONS",
    "REMOTE_PEER_LIMITS",
    "REMOTE_PROTOCOL_VERSION",
    "remoteChannel",
  ])
  expect(Object.keys(schema).sort()).toEqual([
    "REMOTE_FRAME_SCHEMAS",
    "assertRemoteJson",
    "copyRemoteJson",
    "remoteSchema",
    "validateRemoteDto",
    "validateRemoteFrame",
    "validateRemoteParams",
    "validateRemoteResult",
  ])
  expect(Object.keys(codec).sort()).toEqual([
    "RemoteDecoder",
    "encodeRemoteBytes",
    "encodeRemoteMessage",
    "prepareRemoteMessage",
    "serializeRemoteMessage",
  ])
  expect(Object.keys(connection)).toEqual(["RemoteConnection"])
  expect(Object.keys(errors).sort()).toEqual(["RemoteError", "RemoteReplyError"])
  expect(Object.keys(writer)).toEqual(["RemoteWriter"])
})
