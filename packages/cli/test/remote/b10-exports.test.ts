import "../server/offline.ts"
import { expect, test } from "bun:test"
import * as fileSource from "../../src/remote/file-source.ts"
import * as imageUpload from "../../src/remote/image-upload.ts"
import * as filesSchema from "../../src/remote/schema/files.ts"
import * as tasksSchema from "../../src/remote/schema/server-tasks.ts"
import * as uploadSchema from "../../src/remote/schema/upload-send.ts"
import * as conversations from "../../src/server/conversations.ts"
import * as support from "../../src/server/file-support.ts"
import * as files from "../../src/server/files.ts"
import * as history from "../../src/server/history-pages.ts"
import * as images from "../../src/server/images.ts"
import * as jobs from "../../src/server/jobs.ts"
import * as messageImages from "../../src/server/message-images.ts"
import * as uploadSend from "../../src/server/upload-send.ts"
import * as uploads from "../../src/server/uploads.ts"

test("B10 host adapters keep their runtime export surface explicit", () => {
  expect(Object.keys(fileSource)).toEqual(["createRemoteFileSource"])
  expect(Object.keys(imageUpload)).toEqual(["sendRemoteImages"])
  expect(Object.keys(filesSchema).sort()).toEqual([
    "MAX_IMAGE_BYTES",
    "MAX_UPLOAD_CHUNK_BYTES",
    "fileOperationSchemas",
    "imageMime",
    "imagePayload",
    "uploadOperationSchemas",
  ])
  expect(Object.keys(tasksSchema)).toEqual(["serverTaskSchemas"])
  expect(Object.keys(uploadSchema)).toEqual(["uploadSendSchema"])
  expect(Object.keys(conversations)).toEqual(["createServerConversations"])
  expect(Object.keys(support).sort()).toEqual(["failure", "operationGuard", "validate"])
  expect(Object.keys(files)).toEqual(["createServerFileOperations"])
  expect(Object.keys(history).sort()).toEqual(["copyHistory", "historyPageEnd"])
  expect(Object.keys(images)).toEqual(["checkedImage"])
  expect(Object.keys(jobs).sort()).toEqual(["SERVER_JOB_OUTPUT_CHARS", "createServerJobs", "serverJobInfo"])
  expect(Object.keys(messageImages)).toEqual(["validateMessageImages"])
  expect(Object.keys(uploadSend)).toEqual(["createUploadSender"])
  expect(Object.keys(uploads)).toEqual(["createServerUploadOperations"])
})
