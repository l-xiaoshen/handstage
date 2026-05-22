# @handstage/core

Core browser automation engine for Handstage. Manages browser connections, Chrome DevTools Protocol (CDP) communication, page context, frame locators, and script injection for reliable browser automation.

## Context isolation

`connectLocal()` creates an isolated browser context by default, including when
`localBrowserLaunchOptions.cdpUrl` points at an already-running browser. This
makes multiple Handstage clients on the same CDP websocket safe by default:
targets from other browser contexts are resumed/detached instead of being left
paused, and `close()` only tears down resources owned by that Handstage context.

Contexts no longer auto-create an initial page. Use `context.newPage()` when a
tab is required. To intentionally attach to the shared default browser context,
set `localBrowserLaunchOptions.context` to `"default"`.