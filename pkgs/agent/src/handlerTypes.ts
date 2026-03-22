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
 * Browser context exposed by Stagehand (`V3.context` after init). Implementations
 * of {@link StagehandAgentToolHandlers} typically hold this.
 */
export interface StagehandAgentContext {
	pages(): Page[]
	activePage(): Page | undefined
	setActivePage(page: Page): void
	newPage(url?: string): Promise<Page>
}

export type StagehandAgentPageEntry = {
	pageId: string
	url: string
	title: string
	activated: boolean
}

export type StagehandAgentPagesOutput = { pages: StagehandAgentPageEntry[] }

export type StagehandAgentNewPageOutput = { pageId: string }

export type StagehandAgentOkResult = { ok: true }
export type StagehandAgentErrResult = { ok: false; error: string }

export type StagehandAgentSetActivePageOutput =
	| StagehandAgentOkResult
	| StagehandAgentErrResult

export type StagehandAgentGotoOutput =
	| { ok: true; url: string }
	| StagehandAgentErrResult

export type StagehandAgentReloadOutput =
	| { ok: true; url: string }
	| StagehandAgentErrResult

export type StagehandAgentHistoryNavOutput =
	| { ok: true; navigated: boolean; url: string }
	| StagehandAgentErrResult

export type StagehandAgentSnapshotOutput =
	| {
			ok: true
			tree: string
			xpathMap: Record<string, string>
			urlMap: Record<string, string>
	  }
	| StagehandAgentErrResult

export type StagehandAgentPageInfoOutput =
	| { ok: true; url: string; title: string }
	| StagehandAgentErrResult

export type StagehandAgentPointerOutput =
	| { ok: true; xpathAtPoint?: string }
	| StagehandAgentErrResult

export type StagehandAgentTypeOutput =
	| StagehandAgentOkResult
	| StagehandAgentErrResult

export type StagehandAgentElementActionOutput =
	| StagehandAgentOkResult
	| StagehandAgentErrResult

/**
 * Implementations perform Stagehand actions for each tool. Inputs match the Zod
 * schemas in `./schemas`; outputs match the tool’s intended results.
 */
export interface StagehandAgentToolHandlers {
	pages(input: PagesInput): Promise<StagehandAgentPagesOutput>
	newPage(input: NewPageInput): Promise<StagehandAgentNewPageOutput>
	setActivePage(
		input: SetActivePageInput,
	): Promise<StagehandAgentSetActivePageOutput>
	goto(input: GotoInput): Promise<StagehandAgentGotoOutput>
	reload(input: ReloadInput): Promise<StagehandAgentReloadOutput>
	goBack(input: GoBackInput): Promise<StagehandAgentHistoryNavOutput>
	goForward(input: GoForwardInput): Promise<StagehandAgentHistoryNavOutput>
	snapshot(input: SnapshotInput): Promise<StagehandAgentSnapshotOutput>
	pageInfo(input: PageInfoInput): Promise<StagehandAgentPageInfoOutput>
	click(input: ClickInput): Promise<StagehandAgentPointerOutput>
	hover(input: HoverInput): Promise<StagehandAgentPointerOutput>
	scroll(input: ScrollInput): Promise<StagehandAgentPointerOutput>
	type(input: TypeInput): Promise<StagehandAgentTypeOutput>
	click_on(input: ClickOnInput): Promise<StagehandAgentElementActionOutput>
	fill_on(input: FillOnInput): Promise<StagehandAgentElementActionOutput>
	type_on(input: TypeOnInput): Promise<StagehandAgentElementActionOutput>
	hover_on(input: HoverOnInput): Promise<StagehandAgentElementActionOutput>
}
