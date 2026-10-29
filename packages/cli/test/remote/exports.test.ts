import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { FrontendOperations } from "@amira/core"
import * as codec from "../../src/remote/codec.ts"
import * as connection from "../../src/remote/connection.ts"
import * as errors from "../../src/remote/errors.ts"
import * as broker from "../../src/remote/model-broker.ts"
import * as modelCodec from "../../src/remote/model-codec.ts"
import * as numericForms from "../../src/remote/model-numeric-forms.ts"
import * as observableStrings from "../../src/remote/model-observable-strings.ts"
import * as outboundFilter from "../../src/remote/model-outbound-filter.ts"
import * as modelPeer from "../../src/remote/model-peer.ts"
import * as redaction from "../../src/remote/model-redaction.ts"
import * as retention from "../../src/remote/model-retention.ts"
import * as modelSchema from "../../src/remote/model-schema.ts"
import * as stringHistory from "../../src/remote/model-string-history.ts"
import * as stringMasks from "../../src/remote/model-string-masks.ts"
import * as peerCompat from "../../src/remote/peer-compat.ts"
import * as protocol from "../../src/remote/protocol.ts"
import * as bindings from "../../src/remote/provider-bindings.ts"
import * as proxy from "../../src/remote/proxy-ai.ts"
import * as gate from "../../src/remote/proxy-gate.ts"
import * as replay from "../../src/remote/replay.ts"
import * as workspaceSchema from "../../src/remote/schema/workspace.ts"
import * as secretPatterns from "../../src/remote/secret-patterns.ts"
import * as secretVariants from "../../src/remote/secret-variants.ts"
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
    "CONTEXT_WINDOW_SOURCE_PROVIDER_CAPABILITY",
    "REMOTE_FRONTEND_OPERATIONS",
    "REMOTE_GATED_VALUES",
    "REMOTE_LIMITS",
    "REMOTE_OPERATIONS",
    "REMOTE_PEER_LIMITS",
    "REMOTE_PROTOCOL_VERSION",
    "remoteChannel",
    "remoteOperationChannel",
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
  expect(Object.keys(proxy).sort()).toEqual(["ProxyAi", "createProxyAi"])
  expect(Object.keys(gate).sort()).toEqual(["PROXY_RECONNECT_TIMEOUT_MS", "ProxyGate", "proxyFailure"])
  expect(Object.keys(modelPeer)).toEqual(["ModelBrokerPeer"])
  expect(Object.keys(retention)).toEqual(["ModelRetention"])
  expect(Object.keys(broker)).toEqual(["createModelBroker"])
  expect(Object.keys(bindings).sort()).toEqual([
    "ModelBindingError",
    "ProviderBindings",
    "createProviderBindings",
  ])
  expect(Object.keys(modelCodec).sort()).toEqual([
    "ModelOutboundError",
    "assertModelOutbound",
    "copyModelInfo",
    "decodeCompactReceipt",
    "decodeCompactResult",
    "decodeModelEvent",
    "decodeModelRequest",
    "encodeCompactReceipt",
    "encodeCompactResult",
    "encodeModelEvent",
    "encodeModelRequest",
  ])
  expect(Object.keys(modelSchema).sort()).toEqual(["modelValueSchema", "validateModelValue"])
  expect(Object.keys(outboundFilter)).toEqual(["ModelOutboundFilter"])
  expect(Object.keys(observableStrings)).toEqual(["modelStringViews"])
  expect(Object.keys(numericForms)).toEqual(["modelNumericForms"])
  expect(Object.keys(stringHistory)).toEqual(["ModelStringHistory"])
  expect(Object.keys(stringMasks).sort()).toEqual(["maskModelFragments", "redactModelValue"])
  expect(Object.keys(secretVariants)).toEqual(["secretVariants"])
  expect(Object.keys(secretPatterns)).toEqual(["secretPatterns"])
  expect(Object.keys(redaction).sort()).toEqual(["ModelStreamRedactor", "redactModelValue"])
  expect(Object.keys(connection)).toEqual(["RemoteConnection"])
  expect(Object.keys(peerCompat)).toEqual(["remoteMessageForPeer"])
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
