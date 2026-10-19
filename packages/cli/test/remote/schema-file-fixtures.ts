const invalidParams = [{}]
const invalidResults = [null]
const page = { generation: "listing", entries: ["工作:tree/file.ts"], partial: false }
export const fileFixtures = {
  "files.list": { params: {}, result: page, invalidParams: [{ limit: 101 }], invalidResults },
  "files.refresh": { params: {}, result: page, invalidParams: [{ cwd: "/home/escape" }], invalidResults },
  "files.cancel": {
    params: { generation: "listing" },
    result: { cancelled: true },
    invalidParams,
    invalidResults,
  },
  "images.read": {
    params: { path: "画.png" },
    result: { name: "画.png", mimeType: "image/png" as const, data: "iVBORw0KGgo=", bytes: 8 },
    invalidParams,
    invalidResults,
  },
  "artifacts.read": {
    params: { id: "a_123456" },
    result: { name: "output.txt", data: "aA==", bytes: 1 },
    invalidParams,
    invalidResults,
  },
  "uploads.begin": {
    params: { name: "画.png", mimeType: "image/png" as const, bytes: 8, sha256: "a".repeat(64) },
    result: { uploadId: "upload" },
    invalidParams: [{ name: "../x.png", mimeType: "image/png", bytes: 8, sha256: "a".repeat(64) }],
    invalidResults,
  },
  "uploads.chunk": {
    params: { uploadId: "upload", offset: 0, data: "iVBORw0KGgo=" },
    result: { received: 8 },
    invalidParams,
    invalidResults,
  },
  "uploads.finish": {
    params: { uploadId: "upload" },
    result: { attachmentId: "attachment" },
    invalidParams,
    invalidResults,
  },
  "uploads.cancel": {
    params: { uploadId: "upload" },
    result: { cancelled: true },
    invalidParams,
    invalidResults,
  },
  "uploads.send": {
    params: {
      operation: "turn.steer" as const,
      message: {
        role: "user" as const,
        content: [{ type: "attachment" as const, attachmentId: "attachment" }],
      },
    },
    result: { sessionGeneration: 1 },
    invalidParams: [{ operation: "turn.abort", message: { role: "user", content: [] } }],
    invalidResults,
  },
}
