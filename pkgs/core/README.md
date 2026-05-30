# @handstage/core

Core browser automation engine for Handstage. Manages CDP connections,
target routing, page/frame lifecycle, and script injection for reliable
browser automation.

## Connection ownership

Connection subpath factories own the CDP connection they construct:

- `connectLocal(chrome)` from `@handstage/core/connect/local` — attaches to
  a launched Chrome pipe and owns the connection.
- `connectWS(ws)` from `@handstage/core/connect/ws` — wraps a browser
  WebSocket and owns the connection. `close()` closes the WebSocket.
- `connectTransport(transport)` from `@handstage/core/connect/transport` —
  wraps and owns a raw `CDPTransport`.
- `connectSession(session)` from `@handstage/core/connect/session` — wraps
  and owns an `ExternalCDPSession`.
- `connectConnection(existingConnection)` from
  `@handstage/core/connect/connection` — explicit sharing entrypoint. V3 does
  NOT close the connection on `close()`; the caller does.

Wrapping the same `transport` or `session` again throws
`HandstageTransportAlreadyOwnedError`.

`V3Context.close()` only ever calls `Target.disposeBrowserContext` (for
dedicated contexts). It never tears down the underlying CDP connection —
that responsibility lives with `V3` or, for shared connections, the caller.

## Default-context attach

Handstage creates instances containing the `defaultBrowserContext()` by default (which aligns with Puppeteer's `puppeteer.connect` and `puppeteer.launch`).
Two Handstage clients on the same CDP websocket therefore share the default browser context natively without breaking. If you want isolation, call `v3.createBrowserContext()`, which returns an isolated browser context. Targets owned by other browser contexts are resumed/detached at the target router rather than left paused.

To intentionally attach to the shared default context (and accept that
other actors may race with you on a shared tab), simply use the default browser context (i.e. `v3.newPage()`).

## Active page is gone

Contexts no longer auto-create an initial page and there is no
`context.activePage()` / `setActivePage()` / `awaitActivePage()`. Track
`Page` references yourself (from `newPage()` / `pages()`) and call
`page.bringToFront()` if you want to foreground a tab.

## Per-instance logging

Pass `logger:` to any connection factory and that logger receives every log
from that V3's contexts / pages / network managers / target-router delegate.
Two V3 instances on a shared connection each receive router-level debug lines
via broadcast.
