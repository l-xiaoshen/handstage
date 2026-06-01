import type { Context, Page } from "@handstage/core"
import type { HandstageAgentToolHandlers } from "./handlerTypes"
import { errResult, tryAgentResult, withPage } from "./result"
import type {
	ClickOnIdInput,
	ClickOnIdOutput,
	ClosePageInput,
	ClosePageOutput,
	FillOnIdInput,
	FillOnIdOutput,
	GoBackInput,
	GoBackOutput,
	GoForwardInput,
	GoForwardOutput,
	GotoInput,
	GotoOutput,
	HoverOnIdInput,
	HoverOnIdOutput,
	NewPageInput,
	NewPageOutput,
	PagesInput,
	PagesOutput,
	ReloadInput,
	ReloadOutput,
	SnapshotDomInput,
	SnapshotDomOutput,
	TypeOnIdInput,
	TypeOnIdOutput,
} from "./types"

type DeepLocator = ReturnType<Page["deepLocator"]>

export class HandstageContextAgentToolHandlers
	implements HandstageAgentToolHandlers
{
	constructor(private readonly ctx: Context) {}

	async pages(_input: PagesInput): Promise<PagesOutput> {
		const pages = await Promise.all(
			this.ctx.pages().map(async (page) => ({
				pageId: page.pageId,
				url: page.url(),
				title: await page.title(),
			})),
		)
		return { pages }
	}

	async newPage(input: NewPageInput): Promise<NewPageOutput> {
		const page = await this.ctx.newPage(input.url ?? "about:blank")
		return { pageId: page.pageId }
	}

	async closePage(input: ClosePageInput): Promise<ClosePageOutput> {
		const page = this.ctx.resolvePageByTargetId(input.pageId)
		if (!page) return errResult(`Unknown pageId: ${input.pageId}`)
		return tryAgentResult(async () => {
			await page.close()
			return {}
		})
	}

	async goto(input: GotoInput): Promise<GotoOutput> {
		return withPage(this.ctx, input.pageId, async (page) => {
			await page.goto(input.url, {
				waitUntil: input.waitUntil,
				timeoutMs: input.timeoutMs,
			})
			return { url: page.url() }
		})
	}

	async reload(input: ReloadInput): Promise<ReloadOutput> {
		return withPage(this.ctx, input.pageId, async (page) => {
			await page.reload({
				waitUntil: input.waitUntil,
				timeoutMs: input.timeoutMs,
				ignoreCache: input.ignoreCache,
			})
			return { url: page.url() }
		})
	}

	async goBack(input: GoBackInput): Promise<GoBackOutput> {
		return withPage(this.ctx, input.pageId, async (page) => {
			const response = await page.goBack({
				waitUntil: input.waitUntil,
				timeoutMs: input.timeoutMs,
			})
			return { navigated: response !== null, url: page.url() }
		})
	}

	async goForward(input: GoForwardInput): Promise<GoForwardOutput> {
		return withPage(this.ctx, input.pageId, async (page) => {
			const response = await page.goForward({
				waitUntil: input.waitUntil,
				timeoutMs: input.timeoutMs,
			})
			return { navigated: response !== null, url: page.url() }
		})
	}

	async snapshot_dom(input: SnapshotDomInput): Promise<SnapshotDomOutput> {
		return withPage(this.ctx, input.pageId, async (page) => {
			const snapshot = await page.snapshot({
				includeIframes: input.includeIframes,
			})
			return {
				tree: snapshot.formattedTree,
				xpathMap: snapshot.xpathMap,
				urlMap: snapshot.urlMap,
			}
		})
	}

	async click_on_id(input: ClickOnIdInput): Promise<ClickOnIdOutput> {
		return this.actOnEncodedId(input.pageId, input.id, (locator) =>
			locator.click(),
		)
	}

	async fill_on_id(input: FillOnIdInput): Promise<FillOnIdOutput> {
		return this.actOnEncodedId(input.pageId, input.id, (locator) =>
			locator.fill(input.value),
		)
	}

	async type_on_id(input: TypeOnIdInput): Promise<TypeOnIdOutput> {
		return this.actOnEncodedId(input.pageId, input.id, (locator) =>
			locator.type(input.text, { delay: input.delay }),
		)
	}

	async hover_on_id(input: HoverOnIdInput): Promise<HoverOnIdOutput> {
		return this.actOnEncodedId(input.pageId, input.id, (locator) =>
			locator.hover(),
		)
	}

	private async actOnEncodedId(
		pageId: string,
		encodedId: string,
		action: (locator: DeepLocator) => Promise<void>,
	): Promise<ClickOnIdOutput> {
		return withPage(this.ctx, pageId, async (page) => {
			const { xpathMap } = await page.snapshot()
			const xpath = xpathMap[encodedId]
			if (!xpath) {
				throw new Error(`Unknown encoded id: ${encodedId}`)
			}
			await action(page.deepLocator(xpath))
			await page.waitForLoadState("networkidle", 5000)
			return {}
		})
	}
}

export function createHandstageContextAgentToolHandlers(
	ctx: Context,
): HandstageAgentToolHandlers {
	return new HandstageContextAgentToolHandlers(ctx)
}
