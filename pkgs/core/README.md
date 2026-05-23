# @handstage/core

Core browser automation engine for Handstage. Manages CDP connections,
target routing, page/frame lifecycle, and script injection for reliable
browser automation.

## Connection ownership

`V3` (alias `Handstage`) owns the CDP connection it constructs:

- `V3.connectLocal({ cdpUrl?, ... })` — opens (or attaches via WS) and owns
  the connection. `close()` closes the WebSocket.
- `V3.connectTransport(transport)` — wraps and owns a raw `CDPTransport`.
  Wrapping the same `transport` again throws
  `HandstageTransportAlreadyOwnedError`.
- `V3.connectSession(session)` — wraps and owns an `ExternalCDPSession`.
  Same ownership rule as transports.
- `V3.connectConnection(existingConnection)` — explicit sharing entrypoint.
  V3 does NOT close the connection on `close()`; the caller does.

`V3Context.close()` only ever calls `Target.disposeBrowserContext` (for
dedicated contexts). It never tears down the underlying CDP connection —
that responsibility lives with `V3` or, for shared connections, the caller.

## Default-context attach

`connectLocal()` creates an isolated browser context by default, including
when `localBrowserLaunchOptions.cdpUrl` points at an already-running browser.
Two Handstage clients on the same CDP websocket therefore can't see each
other's pages or storage. Targets owned by other browser contexts are
resumed/detached at the target router rather than left paused.

To intentionally attach to the shared default context (and accept that
other actors may race with you on a shared tab), set
This is handled natively by Handstage.

## Active page is gone

Contexts no longer auto-create an initial page and there is no
`context.activePage()` / `setActivePage()` / `awaitActivePage()`. Track
`Page` references yourself (from `newPage()` / `pages()`) and call
`page.bringToFront()` if you want to foreground a tab.

## Per-instance logging

Pass `logger:` to any `V3.connect*` factory and that logger receives every
log from that V3's contexts / pages / network managers / target-router
delegate. Two V3 instances on a shared connection each receive router-level
debug lines via broadcast.
