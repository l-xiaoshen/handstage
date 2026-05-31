# Handstage

Handstage is a framework for browser automation designed for AI agent interaction. It provides low-level Chrome DevTools Protocol (CDP) bindings, a robust DOM querying layer, and high-level agent integrations.

## Packages

- **`@handstage/core`**: Core browser automation engine managing CDP connections and page context.
- **`@handstage/dom`**: In-browser scripts for element locators, shadow DOM piercing, and accessibility snapshots.
- **`@handstage/agent`**: AI agent tools and schemas for driving the browser.

## Multi-context CDP Model

Handstage attaches to the browser's default context by default, which aligns
with Puppeteer's `connect` and `launch` behavior. Two Handstage clients on the
same CDP websocket therefore share the default browser context natively.

Use `handstage.createBrowserContext()` when you want isolation. Dedicated
browser contexts have their own cookies, storage, pages, init scripts, and
extra HTTP headers.

### Connection ownership

- Connection factories in `@handstage/core/connect/*` decide ownership.
  `Handstage.close()` closes owned connections.
- `Context` never closes a connection it didn't construct. Dedicated
  contexts call `Target.disposeBrowserContext`; default contexts release
  nothing browser-side because they're shared with other actors.
- `connectConnection(existingConnection)` from
  `@handstage/core/connect/connection` is the explicit entrypoint for
  sharing one `CDPConnectionLike` across multiple Handstage instances.
  Handstage instances created this way do NOT close the shared connection on
  `close()`. Wrapping
  the same raw `CDPTransport` or `ExternalCDPSession` in two
  `CDPConnection` / `ExternalConnectionAdapter` objects throws
  `HandstageTransportAlreadyOwnedError` — silently clobbering each other's
  callbacks was the previous behavior and was a multi-context footgun.

### No implicit active page

Contexts start empty and stay empty. Callers track `Page` references they
received from `newPage()` (or `pages()` / `createBrowserContext().newPage()`)
explicitly and pass them around — there is no `context.activePage()`
singleton. To foreground a tab in headful Chrome, call
`page.bringToFront()` (wraps `Target.activateTarget`).

### Logging per instance

Every `Handstage` instance has its own `LogSink` plumbed through `Context` →
`Page` → `NetworkManager` / `TargetRouter` / utilities, so two Handstage
instances each receive their own debug lines from event-driven code paths.
Router-level debug lines on a shared connection are broadcast to every
attached Handstage logger.

To opt into the browser's shared default context, just use the provided methods without creating an isolated context. Handstage now aligns natively with Puppeteer. Concurrent clients that
intentionally drive the same default-context tab can still logically race —
Handstage prevents target-pausing deadlocks and accidental cross-context
ownership, but it does not serialize independent actors controlling one tab.
