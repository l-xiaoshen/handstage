import type { Protocol } from "devtools-protocol"
import { HandstageInvalidArgumentError } from "../types/public/sdkErrors"
import type { CDPSessionLike } from "./cdp"

type Delay = (delayMs: number) => Promise<void>
type ModifierKey = "Alt" | "Control" | "Meta" | "Shift"
type KeyDefinition = {
	key: string
	code: string
	vk: number
	text?: string
	unmodifiedText?: string
}

const MODIFIER_MASKS: Record<ModifierKey, number> = {
	Alt: 1,
	Control: 2,
	Meta: 4,
	Shift: 8,
}

const NAMED_KEYS: Readonly<Record<string, KeyDefinition>> = {
	Enter: {
		key: "Enter",
		code: "Enter",
		vk: 13,
		text: "\r",
		unmodifiedText: "\r",
	},
	Tab: { key: "Tab", code: "Tab", vk: 9 },
	Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	Escape: { key: "Escape", code: "Escape", vk: 27 },
	Delete: { key: "Delete", code: "Delete", vk: 46 },
	ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	Home: { key: "Home", code: "Home", vk: 36 },
	End: { key: "End", code: "End", vk: 35 },
	PageUp: { key: "PageUp", code: "PageUp", vk: 33 },
	PageDown: { key: "PageDown", code: "PageDown", vk: 34 },
	Alt: { key: "Alt", code: "AltLeft", vk: 18 },
	Control: { key: "Control", code: "ControlLeft", vk: 17 },
	Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
	Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
}

const MAC_COMMANDS: Readonly<Record<string, string>> = {
	"Meta+KeyA": "selectAll",
	"Meta+KeyC": "copy",
	"Meta+KeyX": "cut",
	"Meta+KeyV": "paste",
	"Meta+KeyZ": "undo",
}

const RANDOM_PRINTABLE_CHARACTERS =
	"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:'\"!?@#$%^&*()-_=+[]{}<>/\\|`~"

function isModifierKey(key: string): key is ModifierKey {
	return Object.hasOwn(MODIFIER_MASKS, key)
}

function isMacOS(): boolean {
	try {
		return process.platform === "darwin"
	} catch {
		return false
	}
}

function splitKeyCombination(key: string): string[] {
	if (key === "+") {
		return [key]
	}

	const keys: string[] = []
	let current = ""
	for (const character of key) {
		if (character === "+" && current) {
			keys.push(current)
			current = ""
			continue
		}
		current += character
	}
	if (current) {
		keys.push(current)
	}
	return keys
}

export class Keyboard {
	private readonly pressedModifiers = new Set<ModifierKey>()
	private readonly macOS = isMacOS()

	constructor(
		private readonly session: CDPSessionLike,
		private readonly delay: Delay,
	) {}

	public reset(): void {
		this.pressedModifiers.clear()
	}

	public async typeText(
		text: string,
		options?: { delay?: number; withMistakes?: boolean },
	): Promise<void> {
		const delayMs = Math.max(0, options?.delay ?? 0)
		const withMistakes = options?.withMistakes === true

		for (const character of text) {
			if (character === "\n" || character === "\r") {
				await this.stroke({ key: "Enter", code: "Enter", vk: 13 })
			} else if (character === "\t") {
				await this.stroke({ key: "Tab", code: "Tab", vk: 9 })
			} else {
				if (withMistakes && Math.random() < 0.12) {
					const wrongCharacter = this.randomPrintable(character)
					await this.stroke(this.printableKey(wrongCharacter), wrongCharacter)
					await this.wait(delayMs)
					await this.stroke({ key: "Backspace", code: "Backspace", vk: 8 })
					await this.wait(delayMs)
				}
				await this.stroke(this.printableKey(character), character)
			}
			await this.wait(delayMs)
		}
	}

	public async press(key: string, options?: { delay?: number }): Promise<void> {
		const tokens = splitKeyCombination(key)
		const mainKey = tokens.at(-1)
		if (!mainKey) {
			throw new HandstageInvalidArgumentError("Invalid key combination")
		}
		const modifiers = tokens.slice(0, -1)

		try {
			for (const modifier of modifiers) {
				await this.keyDown(modifier)
			}
			await this.keyDown(mainKey)
			await this.wait(Math.max(0, options?.delay ?? 0))
			await this.keyUp(mainKey)

			for (let index = modifiers.length - 1; index >= 0; index--) {
				const modifier = modifiers[index]
				if (!modifier) {
					throw new HandstageInvalidArgumentError(
						"Invalid key combination modifier",
					)
				}
				await this.keyUp(modifier)
			}
		} catch (error) {
			this.reset()
			throw error
		}
	}

	private async stroke(
		key: { key: string; code?: string; vk?: number },
		text?: string,
	): Promise<void> {
		const down: Protocol.Input.DispatchKeyEventRequest = {
			type: "keyDown",
			key: key.key,
			code: key.code,
			windowsVirtualKeyCode: key.vk,
			text,
			unmodifiedText: text,
		}
		await this.session.send("Input.dispatchKeyEvent", down)
		await this.session.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: key.key,
			code: key.code,
			windowsVirtualKeyCode: key.vk,
		})
	}

	private async keyDown(key: string): Promise<void> {
		const normalizedKey = this.normalizeKey(key)
		if (isModifierKey(normalizedKey)) {
			this.pressedModifiers.add(normalizedKey)
		}
		const modifiers = this.modifierMask()

		if (normalizedKey.length === 1) {
			if (this.hasNonShiftModifier()) {
				const printable = this.describePrintableKey(normalizedKey)
				const request: Protocol.Input.DispatchKeyEventRequest = {
					type: "rawKeyDown",
					modifiers,
					key: printable.key,
					code: printable.code,
					windowsVirtualKeyCode: printable.vk,
				}
				const commands = this.macCommandsFor(printable.code)
				if (commands.length > 0) {
					request.commands = commands
				}
				await this.session.send("Input.dispatchKeyEvent", request)
				return
			}

			await this.session.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				text: normalizedKey,
				unmodifiedText: normalizedKey,
				modifiers,
			})
			return
		}

		const definition = NAMED_KEYS[normalizedKey]
		if (!definition) {
			await this.session.send("Input.dispatchKeyEvent", {
				type: "keyDown",
				key: normalizedKey,
				modifiers,
			})
			return
		}

		const includeText = Boolean(definition.text) && modifiers === 0
		const request: Protocol.Input.DispatchKeyEventRequest = {
			type: includeText ? "keyDown" : "rawKeyDown",
			key: definition.key,
			code: definition.code,
			windowsVirtualKeyCode: definition.vk,
			modifiers,
		}
		if (includeText) {
			request.text = definition.text
			request.unmodifiedText = definition.unmodifiedText ?? definition.text
		}
		const commands = this.macCommandsFor(definition.code)
		if (commands.length > 0) {
			request.commands = commands
		}
		await this.session.send("Input.dispatchKeyEvent", request)
	}

	private async keyUp(key: string): Promise<void> {
		const normalizedKey = this.normalizeKey(key)
		const modifiers = this.modifierMask()
		if (isModifierKey(normalizedKey)) {
			this.pressedModifiers.delete(normalizedKey)
		}

		if (normalizedKey.length === 1) {
			const printable = this.describePrintableKey(normalizedKey)
			await this.session.send("Input.dispatchKeyEvent", {
				type: "keyUp",
				key: printable.key,
				code: printable.code,
				windowsVirtualKeyCode: printable.vk,
				modifiers,
			})
			return
		}

		const definition = NAMED_KEYS[normalizedKey]
		await this.session.send("Input.dispatchKeyEvent", {
			type: "keyUp",
			key: definition?.key ?? normalizedKey,
			code: definition?.code,
			windowsVirtualKeyCode: definition?.vk,
			modifiers,
		})
	}

	private modifierMask(): number {
		let mask = 0
		for (const modifier of this.pressedModifiers) {
			mask |= MODIFIER_MASKS[modifier]
		}
		return mask
	}

	private hasNonShiftModifier(): boolean {
		return (
			this.pressedModifiers.has("Alt") ||
			this.pressedModifiers.has("Control") ||
			this.pressedModifiers.has("Meta")
		)
	}

	private normalizeKey(key: string): string {
		switch (key.toLowerCase()) {
			case "cmd":
			case "command":
			case "controlormeta":
				return this.macOS ? "Meta" : "Control"
			case "win":
			case "windows":
			case "meta":
				return "Meta"
			case "ctrl":
			case "control":
				return "Control"
			case "option":
			case "alt":
				return "Alt"
			case "shift":
				return "Shift"
			case "enter":
			case "return":
				return "Enter"
			case "esc":
			case "escape":
				return "Escape"
			case "backspace":
				return "Backspace"
			case "tab":
				return "Tab"
			case "space":
			case "spacebar":
				return " "
			case "delete":
			case "del":
				return "Delete"
			case "left":
			case "arrowleft":
				return "ArrowLeft"
			case "right":
			case "arrowright":
				return "ArrowRight"
			case "up":
			case "arrowup":
				return "ArrowUp"
			case "down":
			case "arrowdown":
				return "ArrowDown"
			case "home":
				return "Home"
			case "end":
				return "End"
			case "pageup":
			case "pgup":
				return "PageUp"
			case "pagedown":
			case "pgdn":
				return "PageDown"
			default:
				return key
		}
	}

	private describePrintableKey(character: string): {
		key: string
		code?: string
		vk?: number
	} {
		const shiftDown = this.pressedModifiers.has("Shift")
		if (/^[a-zA-Z]$/.test(character)) {
			const upper = character.toUpperCase()
			return {
				key: shiftDown ? upper : upper.toLowerCase(),
				code: `Key${upper}`,
				vk: upper.charCodeAt(0),
			}
		}
		if (/^[0-9]$/.test(character)) {
			return {
				key: character,
				code: `Digit${character}`,
				vk: character.charCodeAt(0),
			}
		}
		if (character === " ") {
			return { key: " ", code: "Space", vk: 32 }
		}
		return {
			key: shiftDown ? character.toUpperCase() : character,
			vk: character.toUpperCase().charCodeAt(0),
		}
	}

	private printableKey(character: string): {
		key: string
		code?: string
		vk?: number
	} {
		if (/^[a-zA-Z]$/.test(character)) {
			const upper = character.toUpperCase()
			return { key: character, code: `Key${upper}`, vk: upper.charCodeAt(0) }
		}
		if (/^[0-9]$/.test(character)) {
			return {
				key: character,
				code: `Digit${character}`,
				vk: character.charCodeAt(0),
			}
		}
		if (character === " ") {
			return { key: " ", code: "Space", vk: 32 }
		}
		return { key: character }
	}

	private macCommandsFor(code?: string): string[] {
		if (!this.macOS || !code) {
			return []
		}
		const keys: string[] = []
		for (const modifier of ["Shift", "Control", "Alt", "Meta"] as const) {
			if (this.pressedModifiers.has(modifier)) {
				keys.push(modifier)
			}
		}
		keys.push(code)
		const command = MAC_COMMANDS[keys.join("+")]
		return command ? [command] : []
	}

	private randomPrintable(avoid: string): string {
		let character = avoid
		while (character === avoid) {
			character = RANDOM_PRINTABLE_CHARACTERS.charAt(
				Math.floor(Math.random() * RANDOM_PRINTABLE_CHARACTERS.length),
			)
		}
		return character
	}

	private async wait(delayMs: number): Promise<void> {
		if (delayMs > 0) {
			await this.delay(delayMs)
		}
	}
}
