import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { FrontendOperations } from "@amira/core"
import * as codec from "../../src/remote/codec.ts"
import * as connection from "../../src/remote/connection.ts"
import * as errors from "../../src/remote/errors.ts"
import * as protocol from "../../src/remote/protocol.ts"
import * as replay from "../../src/remote/replay.ts"
import * as workspaceSchema from "../../src/remote/schema/workspace.ts"
import * as writer from "../../src/remote/writer.ts"
import * as schema from "../../src/remote-schema.ts"
import * as attachments from "../../src/server/attachments.ts"
import * as controller from "../../src/server/controller.ts"
import * as journal from "../../src/server/journal.ts"
import * as ledger from "../../src/server/operation-ledger.ts"
import * as observers from "../../src/server/operation-observers.ts"
import type { ServerOperations } from "../../src/server/operations.ts"
import * as pendingState from "../../src/server/pending-state.ts"

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
    "backgroundJob",
    "copyRemoteJson",
    "remoteSchema",
    "validateRemoteDto",
    "validateRemoteFrame",
    "validateRemoteParams",
    "validateRemoteResult",
    "workspaceSnapshot",
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
  expect(Object.keys(replay)).toEqual(["RemoteReplay"])
  expect(Object.keys(attachments)).toEqual(["workspaceAttachments"])
  expect(Object.keys(controller)).toEqual(["Controller"])
  expect(Object.keys(journal)).toEqual(["ReplayJournal"])
  expect(Object.keys(ledger)).toEqual(["OperationLedger"])
  expect(Object.keys(observers)).toEqual(["OperationObservers"])
  expect(Object.keys(pendingState)).toEqual(["createPendingStateReader"])
  expect(Object.keys(workspaceSchema).sort()).toEqual([
    "backgroundJob",
    "holdState",
    "inputQueue",
    "noticeInbox",
    "noticeRetry",
    "ownerState",
    "workspaceSemantic",
    "workspaceSnapshot",
  ])
})
