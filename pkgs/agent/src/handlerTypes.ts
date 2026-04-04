import type { Page } from "@handstage/core"
import type {
	ClickInput,
	ClickOnInput,
	FillOnInput,
	GoBackInput,
	GoForwardInput,
	GotoInput,
	HoverInput,
	HoverOnInput,
	NewPageInput,
	PageInfoInput,
	PagesInput,
	ReloadInput,
	ScrollInput,
	SetActivePageInput,
	SnapshotInput,
	TypeInput,
	TypeOnInput,
} from "./schemas"

/**
 * Browser context exposed by Handstages (`V3.context` after init). Implementations
 * of {@link HandstagesAgentToolHandlers} typically hold this.
 */
export interface HandstagesAgentContext {
	pages(): Page[]
	activePage(): Page | undefined
	setActivePage(page: Page): void
	newPage(url?: string): Promise<Page>
}

export type HandstagesAgentPageEntry = {
	pageId: string
	url: string
	title: string
	activated: boolean
}

export type HandstagesAgentPagesOutput = { pages: HandstagesAgentPageEntry[] }

export type HandstagesAgentNewPageOutput = { pageId: string }

export type HandstagesAgentOkResult = { ok: true }
export type HandstagesAgentErrResult = { ok: false; error: string }

export type HandstagesAgentSetActivePageOutput =
	| HandstagesAgentOkResult
	| HandstagesAgentErrResult

export type HandstagesAgentGotoOutput =
	| { ok: true; url: string }
	| HandstagesAgentErrResult

export type HandstagesAgentReloadOutput =
	| { ok: true; url: string }
	| HandstagesAgentErrResult

export type HandstagesAgentHistoryNavOutput =
	| { ok: true; navigated: boolean; url: string }
	| HandstagesAgentErrResult

export type HandstagesAgentSnapshotOutput =
	| {
			ok: true
			tree: string
			xpathMap: Record<string, string>
			urlMap: Record<string, string>
	  }
	| HandstagesAgentErrResult

export type HandstagesAgentPageInfoOutput =
	| { ok: true; url: string; title: string }
	| HandstagesAgentErrResult

export type HandstagesAgentPointerOutput =
	| { ok: true; xpathAtPoint?: string }
	| HandstagesAgentErrResult

export type HandstagesAgentTypeOutput =
	| HandstagesAgentOkResult
	| HandstagesAgentErrResult

export type HandstagesAgentElementActionOutput =
	| HandstagesAgentOkResult
	| HandstagesAgentErrResult

/**
 * Implementations perform Handstages actions for each tool. Inputs match the Zod
 * schemas in `./schemas`; outputs match the tool’s intended results.
 */
export interface HandstagesAgentToolHandlers {
	pages(input: PagesInput): Promise<HandstagesAgentPagesOutput>
	newPage(input: NewPageInput): Promise<HandstagesAgentNewPageOutput>
	setActivePage(
		input: SetActivePageInput,
	): Promise<HandstagesAgentSetActivePageOutput>
	goto(input: GotoInput): Promise<HandstagesAgentGotoOutput>
	reload(input: ReloadInput): Promise<HandstagesAgentReloadOutput>
	goBack(input: GoBackInput): Promise<HandstagesAgentHistoryNavOutput>
	goForward(input: GoForwardInput): Promise<HandstagesAgentHistoryNavOutput>
	snapshot(input: SnapshotInput): Promise<HandstagesAgentSnapshotOutput>
	pageInfo(input: PageInfoInput): Promise<HandstagesAgentPageInfoOutput>
	click(input: ClickInput): Promise<HandstagesAgentPointerOutput>
	hover(input: HoverInput): Promise<HandstagesAgentPointerOutput>
	scroll(input: ScrollInput): Promise<HandstagesAgentPointerOutput>
	type(input: TypeInput): Promise<HandstagesAgentTypeOutput>
	click_on(input: ClickOnInput): Promise<HandstagesAgentElementActionOutput>
	fill_on(input: FillOnInput): Promise<HandstagesAgentElementActionOutput>
	type_on(input: TypeOnInput): Promise<HandstagesAgentElementActionOutput>
	hover_on(input: HoverOnInput): Promise<HandstagesAgentElementActionOutput>
}
