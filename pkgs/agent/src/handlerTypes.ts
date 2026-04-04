import type { Page } from "@handstage/core"
import type { InferToolInput, InferToolOutput } from "ai"
import type { handstagesAgentTools } from "./definitions"

export type HandstagesAgentToolName = keyof typeof handstagesAgentTools

export type HandstagesAgentPagesInput = InferToolInput<
	(typeof handstagesAgentTools)["pages"]
>
export type HandstagesAgentNewPageInput = InferToolInput<
	(typeof handstagesAgentTools)["newPage"]
>
export type HandstagesAgentSetActivePageInput = InferToolInput<
	(typeof handstagesAgentTools)["setActivePage"]
>
export type HandstagesAgentGotoInput = InferToolInput<
	(typeof handstagesAgentTools)["goto"]
>
export type HandstagesAgentReloadInput = InferToolInput<
	(typeof handstagesAgentTools)["reload"]
>
export type HandstagesAgentGoBackInput = InferToolInput<
	(typeof handstagesAgentTools)["goBack"]
>
export type HandstagesAgentGoForwardInput = InferToolInput<
	(typeof handstagesAgentTools)["goForward"]
>
export type HandstagesAgentSnapshotInput = InferToolInput<
	(typeof handstagesAgentTools)["snapshot"]
>
export type HandstagesAgentPageInfoInput = InferToolInput<
	(typeof handstagesAgentTools)["pageInfo"]
>
export type HandstagesAgentClickInput = InferToolInput<
	(typeof handstagesAgentTools)["click"]
>
export type HandstagesAgentHoverInput = InferToolInput<
	(typeof handstagesAgentTools)["hover"]
>
export type HandstagesAgentScrollInput = InferToolInput<
	(typeof handstagesAgentTools)["scroll"]
>
export type HandstagesAgentTypeInput = InferToolInput<
	(typeof handstagesAgentTools)["type"]
>
export type HandstagesAgentClickOnInput = InferToolInput<
	(typeof handstagesAgentTools)["click_on"]
>
export type HandstagesAgentFillOnInput = InferToolInput<
	(typeof handstagesAgentTools)["fill_on"]
>
export type HandstagesAgentTypeOnInput = InferToolInput<
	(typeof handstagesAgentTools)["type_on"]
>
export type HandstagesAgentHoverOnInput = InferToolInput<
	(typeof handstagesAgentTools)["hover_on"]
>

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

export type HandstagesAgentPagesOutput = InferToolOutput<
	(typeof handstagesAgentTools)["pages"]
>
export type HandstagesAgentNewPageOutput = InferToolOutput<
	(typeof handstagesAgentTools)["newPage"]
>
export type HandstagesAgentSetActivePageOutput = InferToolOutput<
	(typeof handstagesAgentTools)["setActivePage"]
>
export type HandstagesAgentGotoOutput = InferToolOutput<
	(typeof handstagesAgentTools)["goto"]
>
export type HandstagesAgentReloadOutput = InferToolOutput<
	(typeof handstagesAgentTools)["reload"]
>
export type HandstagesAgentHistoryNavOutput = InferToolOutput<
	(typeof handstagesAgentTools)["goBack"]
>
export type HandstagesAgentSnapshotOutput = InferToolOutput<
	(typeof handstagesAgentTools)["snapshot"]
>
export type HandstagesAgentPageInfoOutput = InferToolOutput<
	(typeof handstagesAgentTools)["pageInfo"]
>
export type HandstagesAgentPointerOutput = InferToolOutput<
	(typeof handstagesAgentTools)["click"]
>
export type HandstagesAgentTypeOutput = InferToolOutput<
	(typeof handstagesAgentTools)["type"]
>
export type HandstagesAgentElementActionOutput = InferToolOutput<
	(typeof handstagesAgentTools)["click_on"]
>

export type HandstagesAgentPageEntry =
	HandstagesAgentPagesOutput["pages"][number]

export type HandstagesAgentOkResult = Extract<
	HandstagesAgentSetActivePageOutput,
	{ ok: true }
>
export type HandstagesAgentErrResult = Extract<
	HandstagesAgentSetActivePageOutput,
	{ ok: false }
>

/**
 * Implementations perform Handstages actions for each tool. Inputs and outputs are
 * inferred from {@link handstagesAgentTools} via the AI SDK.
 */
export interface HandstagesAgentToolHandlers {
	pages(input: HandstagesAgentPagesInput): Promise<HandstagesAgentPagesOutput>
	newPage(
		input: HandstagesAgentNewPageInput,
	): Promise<HandstagesAgentNewPageOutput>
	setActivePage(
		input: HandstagesAgentSetActivePageInput,
	): Promise<HandstagesAgentSetActivePageOutput>
	goto(input: HandstagesAgentGotoInput): Promise<HandstagesAgentGotoOutput>
	reload(
		input: HandstagesAgentReloadInput,
	): Promise<HandstagesAgentReloadOutput>
	goBack(
		input: HandstagesAgentGoBackInput,
	): Promise<HandstagesAgentHistoryNavOutput>
	goForward(
		input: HandstagesAgentGoForwardInput,
	): Promise<HandstagesAgentHistoryNavOutput>
	snapshot(
		input: HandstagesAgentSnapshotInput,
	): Promise<HandstagesAgentSnapshotOutput>
	pageInfo(
		input: HandstagesAgentPageInfoInput,
	): Promise<HandstagesAgentPageInfoOutput>
	click(input: HandstagesAgentClickInput): Promise<HandstagesAgentPointerOutput>
	hover(input: HandstagesAgentHoverInput): Promise<HandstagesAgentPointerOutput>
	scroll(
		input: HandstagesAgentScrollInput,
	): Promise<HandstagesAgentPointerOutput>
	type(input: HandstagesAgentTypeInput): Promise<HandstagesAgentTypeOutput>
	click_on(
		input: HandstagesAgentClickOnInput,
	): Promise<HandstagesAgentElementActionOutput>
	fill_on(
		input: HandstagesAgentFillOnInput,
	): Promise<HandstagesAgentElementActionOutput>
	type_on(
		input: HandstagesAgentTypeOnInput,
	): Promise<HandstagesAgentElementActionOutput>
	hover_on(
		input: HandstagesAgentHoverOnInput,
	): Promise<HandstagesAgentElementActionOutput>
}
