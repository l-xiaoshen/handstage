import { type ToolSet, tool } from "ai"
import {
	ClickInputSchema,
	ClickOnInputSchema,
	ElementActionOutputSchema,
	FillOnInputSchema,
	GoBackInputSchema,
	GoForwardInputSchema,
	GotoInputSchema,
	GotoOutputSchema,
	HistoryNavOutputSchema,
	HoverInputSchema,
	HoverOnInputSchema,
	NewPageInputSchema,
	NewPageOutputSchema,
	PageInfoInputSchema,
	PageInfoOutputSchema,
	PagesInputSchema,
	PagesOutputSchema,
	PointerOutputSchema,
	ReloadInputSchema,
	ReloadOutputSchema,
	ScrollInputSchema,
	SetActivePageInputSchema,
	SetActivePageOutputSchema,
	SnapshotInputSchema,
	SnapshotOutputSchema,
	TypeInputSchema,
	TypeOnInputSchema,
	TypeOutputSchema,
} from "./schemas"

/**
 * Handstages browser agent tools: descriptions, `inputSchema`, and `outputSchema` (Zod).
 * Execution is supplied separately via {@link HandstagesAgentToolHandlers}.
 */
export const handstagesAgentTools = {
	pages: tool({
		description:
			"List open browser tabs. Each entry has pageId, url, title, and whether the tab is active (foreground).",
		inputSchema: PagesInputSchema,
		outputSchema: PagesOutputSchema,
	}),

	newPage: tool({
		description:
			"Open a new browser tab. Returns the new tab's pageId. Optional starting URL (defaults to about:blank).",
		inputSchema: NewPageInputSchema,
		outputSchema: NewPageOutputSchema,
	}),

	setActivePage: tool({
		description:
			"Focus a tab by pageId (bring it to the foreground). Use after newPage or when switching context.",
		inputSchema: SetActivePageInputSchema,
		outputSchema: SetActivePageOutputSchema,
	}),

	goto: tool({
		description: "Navigate a tab to a URL.",
		inputSchema: GotoInputSchema,
		outputSchema: GotoOutputSchema,
	}),

	reload: tool({
		description: "Reload the current document in a tab.",
		inputSchema: ReloadInputSchema,
		outputSchema: ReloadOutputSchema,
	}),

	goBack: tool({
		description: "Go back in history for a tab, if possible.",
		inputSchema: GoBackInputSchema,
		outputSchema: HistoryNavOutputSchema,
	}),

	goForward: tool({
		description: "Go forward in history for a tab, if possible.",
		inputSchema: GoForwardInputSchema,
		outputSchema: HistoryNavOutputSchema,
	}),

	snapshot: tool({
		description:
			"Accessibility tree for a tab (multiline text with encoded node ids). Call this to understand what is on screen before interacting.",
		inputSchema: SnapshotInputSchema,
		outputSchema: SnapshotOutputSchema,
	}),

	pageInfo: tool({
		description: "Current URL and document title for a tab.",
		inputSchema: PageInfoInputSchema,
		outputSchema: PageInfoOutputSchema,
	}),

	click: tool({
		description:
			"Click at viewport coordinates (CSS pixels). Does not scroll; ensure the target is visible.",
		inputSchema: ClickInputSchema,
		outputSchema: PointerOutputSchema,
	}),

	hover: tool({
		description: "Move the pointer to viewport coordinates (CSS pixels).",
		inputSchema: HoverInputSchema,
		outputSchema: PointerOutputSchema,
	}),

	scroll: tool({
		description:
			"Dispatch a mouse wheel at viewport coordinates (deltaX/deltaY in pixels).",
		inputSchema: ScrollInputSchema,
		outputSchema: PointerOutputSchema,
	}),

	type: tool({
		description:
			"Type text using key events at the current focus. Focus an input first (e.g. click_on) or tab to it.",
		inputSchema: TypeInputSchema,
		outputSchema: TypeOutputSchema,
	}),

	click_on: tool({
		description:
			"Click the first element matching a CSS or XPath selector in the page's main frame.",
		inputSchema: ClickOnInputSchema,
		outputSchema: ElementActionOutputSchema,
	}),

	fill_on: tool({
		description:
			"Clear and fill an input element matched by a CSS or XPath selector (main frame).",
		inputSchema: FillOnInputSchema,
		outputSchema: ElementActionOutputSchema,
	}),

	type_on: tool({
		description:
			"Type into an element matched by a CSS or XPath selector (focuses the element first).",
		inputSchema: TypeOnInputSchema,
		outputSchema: ElementActionOutputSchema,
	}),

	hover_on: tool({
		description:
			"Hover the first element matching a CSS or XPath selector in the page's main frame.",
		inputSchema: HoverOnInputSchema,
		outputSchema: ElementActionOutputSchema,
	}),
} as const satisfies ToolSet

/**
 * Same object as {@link handstagesAgentTools}; kept for callers that only need a `ToolSet`.
 */
export function createHandstagesAgentToolDefinitions(): ToolSet {
	return handstagesAgentTools
}
