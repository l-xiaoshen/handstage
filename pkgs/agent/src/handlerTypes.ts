import type { Page } from "@handstage/core"
import type {
	// ClickInput,
	ClickOnIdInput,
	ClickOnIdOutput,
	// BringToFrontInput,
	// BringToFrontOutput,
	ClosePageInput,
	ClosePageOutput,
	// ClickOutput,
	FillOnIdInput,
	FillOnIdOutput,
	GoBackInput,
	GoBackOutput,
	GoForwardInput,
	GoForwardOutput,
	GotoInput,
	GotoOutput,
	// HoverInput,
	HoverOnIdInput,
	HoverOnIdOutput,
	// HoverOutput,
	NewPageInput,
	NewPageOutput,
	// PageInfoInput,
	// PageInfoOutput,
	PagesInput,
	PagesOutput,
	ReloadInput,
	ReloadOutput,
	// ScrollInput,
	// ScrollOutput,
	SnapshotDomInput,
	SnapshotDomOutput,
	// TypeInput,
	TypeOnIdInput,
	TypeOnIdOutput,
	// TypeOutput,
} from "./types"

/**
 * Browser context exposed by Handstage (`V3.defaultBrowserContext()`). Implementations
 * of {@link HandstageAgentToolHandlers} typically hold this.
 *
 * There is no implicit "active page" — callers track Page references they
 * received from `newPage()` or `pages()` explicitly, and pass `pageId` on
 * every tool call.
 */
export interface HandstageAgentContext {
	pages(): Page[]
	newPage(url?: string): Promise<Page>
}

/**
 * Implementations perform Handstage actions for each tool. Inputs and outputs are
 * inferred from Zod schemas in {@link ./schemas}.
 */
export interface HandstageAgentToolHandlers {
	pages(input: PagesInput): Promise<PagesOutput>
	newPage(input: NewPageInput): Promise<NewPageOutput>
	closePage(input: ClosePageInput): Promise<ClosePageOutput>
	// bringToFront(
	// 	input: BringToFrontInput,
	// ): Promise<BringToFrontOutput>
	goto(input: GotoInput): Promise<GotoOutput>
	reload(input: ReloadInput): Promise<ReloadOutput>
	goBack(input: GoBackInput): Promise<GoBackOutput>
	goForward(input: GoForwardInput): Promise<GoForwardOutput>
	snapshot_dom(input: SnapshotDomInput): Promise<SnapshotDomOutput>
	// pageInfo(input: PageInfoInput): Promise<PageInfoOutput>
	// click(input: ClickInput): Promise<ClickOutput>
	// hover(input: HoverInput): Promise<HoverOutput>
	// scroll(input: ScrollInput): Promise<ScrollOutput>
	// type(input: TypeInput): Promise<TypeOutput>
	// click_on(input: ClickOnInput): Promise<ClickOnOutput>
	// fill_on(input: FillOnInput): Promise<FillOnOutput>
	// type_on(input: TypeOnInput): Promise<TypeOnOutput>
	// hover_on(input: HoverOnInput): Promise<HoverOnOutput>
	click_on_id(input: ClickOnIdInput): Promise<ClickOnIdOutput>
	fill_on_id(input: FillOnIdInput): Promise<FillOnIdOutput>
	type_on_id(input: TypeOnIdInput): Promise<TypeOnIdOutput>
	hover_on_id(input: HoverOnIdInput): Promise<HoverOnIdOutput>
}
