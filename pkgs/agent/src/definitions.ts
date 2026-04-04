import { type ToolSet, tool } from "ai"
import {
	ClickInputSchema,
	ClickOnInputSchema,
	FillOnInputSchema,
	GoBackInputSchema,
	GoForwardInputSchema,
	GotoInputSchema,
	HoverInputSchema,
	HoverOnInputSchema,
	NewPageInputSchema,
	PageInfoInputSchema,
	PagesInputSchema,
	ReloadInputSchema,
	ScrollInputSchema,
	SetActivePageInputSchema,
	SnapshotInputSchema,
	TypeInputSchema,
	TypeOnInputSchema,
} from "./schemas"

/**
 * AI SDK tool definitions (description + `inputSchema` only). Execution is supplied
 * separately by implementing {@link HandstagesAgentToolHandlers} and wiring it in
 * your agent loop (or a future `bind*` helper).
 */
export function createHandstagesAgentToolDefinitions(): ToolSet {
	return {
		pages: tool({
			description:
				"List open browser tabs. Each entry has pageId, url, title, and whether the tab is active (foreground).",
			inputSchema: PagesInputSchema,
		}),

		newPage: tool({
			description:
				"Open a new browser tab. Returns the new tab's pageId. Optional starting URL (defaults to about:blank).",
			inputSchema: NewPageInputSchema,
		}),

		setActivePage: tool({
			description:
				"Focus a tab by pageId (bring it to the foreground). Use after newPage or when switching context.",
			inputSchema: SetActivePageInputSchema,
		}),

		goto: tool({
			description: "Navigate a tab to a URL.",
			inputSchema: GotoInputSchema,
		}),

		reload: tool({
			description: "Reload the current document in a tab.",
			inputSchema: ReloadInputSchema,
		}),

		goBack: tool({
			description: "Go back in history for a tab, if possible.",
			inputSchema: GoBackInputSchema,
		}),

		goForward: tool({
			description: "Go forward in history for a tab, if possible.",
			inputSchema: GoForwardInputSchema,
		}),

		snapshot: tool({
			description:
				"Accessibility tree for a tab (multiline text with encoded node ids). Call this to understand what is on screen before interacting.",
			inputSchema: SnapshotInputSchema,
		}),

		pageInfo: tool({
			description: "Current URL and document title for a tab.",
			inputSchema: PageInfoInputSchema,
		}),

		click: tool({
			description:
				"Click at viewport coordinates (CSS pixels). Does not scroll; ensure the target is visible.",
			inputSchema: ClickInputSchema,
		}),

		hover: tool({
			description: "Move the pointer to viewport coordinates (CSS pixels).",
			inputSchema: HoverInputSchema,
		}),

		scroll: tool({
			description:
				"Dispatch a mouse wheel at viewport coordinates (deltaX/deltaY in pixels).",
			inputSchema: ScrollInputSchema,
		}),

		type: tool({
			description:
				"Type text using key events at the current focus. Focus an input first (e.g. click_on) or tab to it.",
			inputSchema: TypeInputSchema,
		}),

		click_on: tool({
			description:
				"Click the first element matching a CSS or XPath selector in the page's main frame.",
			inputSchema: ClickOnInputSchema,
		}),

		fill_on: tool({
			description:
				"Clear and fill an input element matched by a CSS or XPath selector (main frame).",
			inputSchema: FillOnInputSchema,
		}),

		type_on: tool({
			description:
				"Type into an element matched by a CSS or XPath selector (focuses the element first).",
			inputSchema: TypeOnInputSchema,
		}),

		hover_on: tool({
			description:
				"Hover the first element matching a CSS or XPath selector in the page's main frame.",
			inputSchema: HoverOnInputSchema,
		}),
	}
}
