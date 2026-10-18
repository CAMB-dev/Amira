import { expect, test } from "bun:test"
import { safeProviderUrl } from "../src/provider-url.ts"

test("provider URL labels retain useful local endpoint details without credentials", () => {
  const endpoint =
    "https://user:URL_PASSWORD@never.invalid:8443/v1?api_key=URL_KEY&region=west#access_token=FRAGMENT_TOKEN"
  expect(safeProviderUrl(endpoint)).toBe("https://never.invalid:8443/v1?region=west")
  expect(safeProviderUrl(endpoint, { originOnly: true })).toBe("https://never.invalid:8443")
  expect(safeProviderUrl("https://never.invalid")).toBe("https://never.invalid")
  expect(safeProviderUrl("http://localhost:8000/v1/")).toBe("http://localhost:8000/v1/")
})

test.each([
  ["https://example.com/", "https://example.com/"],
  ["HTTPS://ExAmPlE.COM:443/", "HTTPS://ExAmPlE.COM:443/"],
  [
    "http://ExAmPlE.COM:80/%2f%7e?a=%2f+b&b=%20&empty=&bare&&",
    "http://ExAmPlE.COM:80/%2f%7e?a=%2f+b&b=%20&empty=&bare&&",
  ],
  [
    "HtTpS://user:URL_PASSWORD@ExAmPlE.COM:443/%2f?region=%77est&api_key=URL_KEY&space=a+b&path=%2f",
    "HtTpS://ExAmPlE.COM:443/%2f?region=%77est&space=a+b&path=%2f",
  ],
  ["https://EXAMPLE.com:443/?", "https://EXAMPLE.com:443/?"],
  ["http://user:URL_PASSWORD@[ABCD::1]:80/?KEY=URL_KEY&safe=%2f#FRAGMENT", "http://[ABCD::1]:80/?safe=%2f"],
  [
    "https://user:URL_PASSWORD@ExAmPlE.com:443/../%2e/path?api%5Fkey=URL_KEY&region=West",
    "https://ExAmPlE.com:443/../%2e/path?region=West",
  ],
  ["https://user:URL_PASSWORD@Host:443?api_key=URL_KEY", "https://Host:443"],
  [
    "https://EXAMPLE.com/?&&first=%2f&token=URL_KEY&&last=a%20b&",
    "https://EXAMPLE.com/?&&first=%2f&&last=a%20b&",
  ],
  ["https://例え.テスト:443/%e3%81%82?x=%2f", "https://例え.テスト:443/%e3%81%82?x=%2f"],
])("local provider URL spelling survives redaction: %s", (endpoint, expected) => {
  expect(safeProviderUrl(endpoint)).toBe(expected)
})

test.each([
  "key",
  "api_key",
  "api-key",
  "ApiKey",
  "api%5Fkey",
  "Access_Token",
  "refresh-token",
  "client_secret",
  "password",
  "passwd",
  "Authorization",
  "credential",
  "X-Amz-Signature",
  "X-Goog-Credential",
  "session_id",
  "cookie",
  "bearer",
  "sig",
  "code",
  "jwt",
])("provider URL labels remove secret-looking query parameter %s", (key) => {
  expect(safeProviderUrl(`https://never.invalid/v1?${key}=SECRET&${key}=OTHER&region=west`)).toBe(
    "https://never.invalid/v1?region=west",
  )
})

test.each([
  "\nhttps://user:PASSWORD@never.invalid",
  "https:///user:PASSWORD@never.invalid",
  "https://user:PASSWORD@never.invalid\\path",
  "https://user:PASS\tWORD@never.invalid",
])("ambiguous local URL spellings never echo credentials: %s", (endpoint) => {
  expect(safeProviderUrl(endpoint)).toBe("(invalid endpoint)")
})

test.each([
  "not a URL: PASSWORD",
  "//user:PASSWORD@never.invalid",
  "javascript:PASSWORD",
  "file:///PASSWORD",
])("unparseable or non-HTTP provider endpoints never echo credential text: %s", (endpoint) => {
  expect(safeProviderUrl(endpoint)).toBe("(invalid endpoint)")
  expect(safeProviderUrl(endpoint, { originOnly: true })).toBe("(invalid endpoint)")
})
