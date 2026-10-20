interface PeerCredentials {
  pid: number
  uid: number
}

async function nativeCredentials(fd: number): Promise<PeerCredentials> {
  const { dlopen, ptr } = await import("bun:ffi")
  const libc = dlopen("libc.so.6", {
    getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
  })
  try {
    const credentials = new Uint32Array(3)
    const length = new Uint32Array([credentials.byteLength])
    // Linux SOL_SOCKET / SO_PEERCRED: kernel-authenticated { pid, uid, gid }.
    if (libc.symbols.getsockopt(fd, 1, 17, ptr(credentials), ptr(length)) !== 0 || length[0] !== 12)
      throw new Error("Daemon peer credentials are unavailable")
    return { pid: credentials[0]!, uid: credentials[1]! }
  } finally {
    libc.close()
  }
}

/** Fail closed if the Bun Node-compatible socket cannot expose a live descriptor. */
export async function readLinuxPeer(
  socket: object,
  read: (fd: number) => Promise<PeerCredentials> = nativeCredentials,
): Promise<PeerCredentials> {
  const handle = Reflect.get(socket, "_handle")
  const fd = handle && typeof handle === "object" ? Reflect.get(handle, "fd") : undefined
  if (!Number.isInteger(fd) || fd < 0 || fd > 2_147_483_647)
    throw new Error("Daemon socket descriptor is unavailable")
  return read(fd)
}
