# Handstage

Handstage is a framework for browser automation designed for AI agent interaction. It provides low-level Chrome DevTools Protocol (CDP) bindings, a robust DOM querying layer, and high-level agent integrations.

## Packages

- **`@handstage/core`**: Core browser automation engine managing CDP connections and page context.
- **`@handstage/dom`**: In-browser scripts for element locators, shadow DOM piercing, and accessibility snapshots.
- **`@handstage/agent`**: AI agent tools and schemas for driving the browser.

## Multi-context CDP model

Handstage is isolated-by-default when launching Chrome or connecting to an
existing browser websocket. Each `connectLocal()` call creates a dedicated
browser context, so two Handstage instances can connect to the same CDP endpoint
without sharing pages, cookies, local storage, init scripts, headers, active-page
state, or close semantics.

Contexts start empty; call `context.newPage()` explicitly when a page is needed.
Advanced users can opt into the browser's shared default context with
`localBrowserLaunchOptions.context = "default"`, but concurrent clients that
intentionally drive the same default-context tab can still logically race.
Handstage prevents target-pausing deadlocks and accidental cross-context
ownership; it does not serialize independent actors controlling one tab.