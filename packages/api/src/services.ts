/**
 * Experimental (D88): services extensions offer each other (ExtensionAPI.provideService and
 * useService), e.g. the browser extension renders HTML to a PNG for the mermaid extension.
 *
 * A service is any value, usually a function or an object of functions, under a name that
 * starts with the providing extension's name ("browser.renderHtmlToPng"). The services known
 * here are typed through this interface; an extension can add its own by declaration merging:
 *
 * ```ts
 * declare module "@amira/api" {
 *   interface AmiraServices {
 *     "myext.lookup": (key: string) => Promise<string | undefined>
 *   }
 * }
 * ```
 *
 * Versioning: a name stands for one contract. A provider may add optional fields and
 * behaviour, never remove or change them; a breaking change takes a new name ("myext.lookup2"),
 * and a provider may offer the old name next to it for a while. Callers look a service up when
 * they use it (the provider may be loaded later, unloaded, or not installed: undefined), and
 * check for optional parts they rely on.
 */
export interface AmiraServices {
  /**
   * Offered by the browser extension: renders a self-contained HTML page in its headless
   * browser, with no network access (everything the page needs must be inline), and returns a
   * PNG of it. Rejects when no browser can be started or the page does not finish in time.
   */
  "browser.renderHtmlToPng": (req: HtmlToPngRequest) => Promise<Uint8Array>
}

export interface HtmlToPngRequest {
  html: string
  /** The page's width in CSS pixels. */
  width: number
  /** The page's height in CSS pixels. Default: as tall as the content (a full-page shot). */
  height?: number
  /** Device pixels per CSS pixel. Default 1. */
  deviceScaleFactor?: number
  /** Only this element is shot, when given (a CSS selector); else the page. */
  selector?: string
  /**
   * The page is shot once it loaded and, when it sets `window.amiraRenderDone` (a promise), once
   * that settles; it rejecting fails the render. Default time for all of it: 15000 ms.
   */
  timeoutMs?: number
}

/** A service name: a known one, or any other an extension offers. */
export type ServiceName = keyof AmiraServices | (string & {})

/** The type of a service by its name: known ones typed, others unknown. */
export type ServiceOf<K extends string> = K extends keyof AmiraServices ? AmiraServices[K] : unknown
