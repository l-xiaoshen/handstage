import { afterAll, beforeAll, expect, test } from "bun:test"
import { devToolsMiddleware } from "@ai-sdk/devtools"
import {
	createOpenAICompatible,
	type OpenAICompatibleProviderOptions,
} from "@ai-sdk/openai-compatible"
import type { Context, Handstage, LaunchedChrome } from "@handstage/core"
import { connectLocal } from "@handstage/core/connect"
import { launchChromeBun } from "@handstage/core/launch/bun"
import {
	defaultSettingsMiddleware,
	hasToolCall,
	ToolLoopAgent,
	tool,
	wrapLanguageModel,
} from "ai"
import z from "zod"
import {
	createHandstageAgentToolDefinitions,
	createHandstageContextAgentToolHandlers,
} from "../src"

// 10 minutes
const TEST_TIMEOUT_MS = 10 * 60 * 1000

const provider = createOpenAICompatible({
	name: "default",
	apiKey: Bun.env.OPENAI_API_KEY,
	baseURL: Bun.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
})

const model = wrapLanguageModel({
	model: provider.languageModel(Bun.env.OPENAI_MODEL ?? "gpt-5.5"),
	middleware: [
		defaultSettingsMiddleware({
			settings: {
				providerOptions: {
					default: {
						reasoningEffort: Bun.env.OPENAI_MODEL_REASONING_EFFORT ?? "max",
					} satisfies OpenAICompatibleProviderOptions,
				},
			},
		}),
		devToolsMiddleware(),
	],
})

let browser: LaunchedChrome
let handstage: Handstage
let context: Context

beforeAll(async () => {
	browser = await launchChromeBun({ headless: !Bun.env.DISPLAY })
	handstage = await connectLocal(browser)
	context = await handstage.createBrowserContext({
		disposeOnDetach: true,
	})
})

afterAll(async () => {
	await context.close()
	await handstage.close()
	await browser.close()
})

type BrowserAgentTask = {
	legal_name: string
	linkedin_company_handle: string
	support_email: string
	phone_number: [number, number, number]
	address: {
		city: string
		state: string
		zip: string
	}
	sub_processors: {
		vendor_name: string
		vendor_purpose: string
	}[]
}

const prompt = `Task is to extract company information from a provided url. 
A url of company's website is provided as input, use browser tools, to navgiate the web, report the legal name and linkedin company handle of the company. 
The task is to gather information within the provided company's website. 
Guess, infer, urls are not allowed. It is crucial to ensure all information gathered, must comes from valid source.`

const testTask: BrowserAgentTask = {
	legal_name: "Rote Inc.",
	linkedin_company_handle: "tryrote",
	support_email: "support@tryrote.com",
	phone_number: [510, 574, 5536],
	address: {
		city: "Ithaca",
		state: "NY",
		zip: "14853",
	},
	sub_processors: [
		{
			vendor_name: "Stripe",
			vendor_purpose: "Payment processing",
		},
		{
			vendor_name: "Amazon Web Services",
			vendor_purpose: "Hosting and document storage",
		},
		{
			vendor_name: "Anthropic (Claude API)",
			vendor_purpose: "Generating supplement text",
		},
		{
			vendor_name: "OpenAI",
			vendor_purpose: "Semantic operation matching",
		},
	],
}

const taskURL = "https://tryrote.com/"

test(
	"extract company info agent",
	async () => {
		const browserAgentHandlers =
			createHandstageContextAgentToolHandlers(context)
		const browserAgentTools =
			createHandstageAgentToolDefinitions(browserAgentHandlers)

		const ReportInfoSchema = z.object({
			legal_name: z.string().describe("The official legal name of the company"),
			linkedin_company_handle: z
				.string()
				.describe("The LinkedIn company handle or identifier"),
			support_email: z
				.string()
				.describe("The support email address of the company"),
			phone_number: z
				.array(z.number())
				.length(3)
				.describe("The phone number of the company in a 3-part array"),
			address: z
				.object({
					city: z.string().describe("The city where the company is located"),
					state: z
						.string()
						.describe("The state short code where the company is located"),
					zip: z
						.string()
						.describe("The ZIP or postal code of the company's address"),
				})
				.describe("The physical address of the company"),
			sub_processors: z
				.array(
					z.object({
						vendor_name: z
							.string()
							.describe("The name of the sub-processor or vendor"),
						vendor_purpose: z
							.string()
							.describe("The purpose of the sub-processor or vendor"),
					}),
				)
				.describe(
					"A list of sub-processors or vendors used by the company, order matters, the order of subprocessors need match the order shown on the company's website",
				),
		})

		type ReportData = z.infer<typeof ReportInfoSchema>

		let reportData: ReportData | undefined

		const browserAgent = new ToolLoopAgent({
			model,
			tools: {
				...browserAgentTools,
				report: tool({
					description: "Report the company information",
					inputSchema: ReportInfoSchema,
					outputSchema: z.object({
						ok: z.literal(true),
					}),
					execute: async (input) => {
						reportData = input
						return {
							ok: true,
						}
					},
				}),
			},
			instructions: prompt,
			stopWhen: [hasToolCall("report")],
		})

		await browserAgent.generate({
			messages: [
				{
					role: "user",
					content: `The company url is ${taskURL}. Navigate the web using browser tools, report the company information.`,
				},
			],
		})

		expect(reportData).toBeDefined()
		expect(reportData).toEqual(testTask)
	},
	TEST_TIMEOUT_MS,
)
