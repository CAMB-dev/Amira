import { expect, test } from "bun:test"
import { assertPublicHost, isPrivateAddress } from "../src/address.ts"
import { publicResolver } from "./util.ts"

test("private, loopback, link-local and reserved addresses are recognised", () => {
  for (const ip of [
    "127.0.0.1",
    "127.8.9.10",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.0.8",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "fe80::1%eth0",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a00:1",
    "2002:c0a8:0101::1",
    "ff02::1",
    "not-an-ip",
  ])
    expect([ip, isPrivateAddress(ip)]).toEqual([ip, true])
  for (const ip of [
    "8.8.8.8",
    "93.184.215.14",
    "172.32.0.1",
    "100.128.0.1",
    "192.0.1.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
    "2002:0808:0808::1",
  ])
    expect([ip, isPrivateAddress(ip)]).toEqual([ip, false])
})

test("hosts are refused by name, by literal address and by what they resolve to", async () => {
  const resolve = publicResolver({ "evil.test": ["93.184.215.14", "10.0.0.5"], "ok.test": ["1.1.1.1"] })
  const check = (u: string) => assertPublicHost(new URL(u), resolve)
  await expect(check("http://localhost:3000/")).rejects.toThrow("private-network")
  await expect(check("http://app.localhost/")).rejects.toThrow("private-network")
  await expect(check("http://127.0.0.1/")).rejects.toThrow("private-network")
  // The URL parser turns these into 127.0.0.1 and ::ffff:7f00:1.
  await expect(check("http://2130706433/")).rejects.toThrow("private-network")
  await expect(check("http://0x7f.1/")).rejects.toThrow("private-network")
  await expect(check("http://[::ffff:127.0.0.1]/")).rejects.toThrow("private-network")
  await expect(check("http://evil.test/")).rejects.toThrow("private-network")
  await expect(check("http://ok.test./")).resolves.toBeUndefined()
  await expect(check("https://1.1.1.1/")).resolves.toBeUndefined()
  const failing = async () => {
    throw new Error("ENOTFOUND")
  }
  await expect(assertPublicHost(new URL("http://nx.test/"), failing)).rejects.toThrow(
    "cannot resolve nx.test",
  )
})
