/**
 * Ownership markers use the global symbol registry so duplicate module realms
 * still observe the same transport and session owners.
 */
export const TRANSPORT_OWNED = Symbol.for("handstage.cdp.transportOwned")
export const SESSION_OWNED = Symbol.for("handstage.cdp.sessionOwned")
export const ABANDONED_OWNER = Object.freeze({ abandoned: true })

export function getOwnership(target: object, marker: symbol): unknown {
	return Reflect.get(target, marker)
}

export function setOwnership(
	target: object,
	marker: symbol,
	owner: unknown,
): void {
	if (!Reflect.set(target, marker, owner)) {
		throw new TypeError("Unable to claim CDP resource ownership")
	}
}

export function deleteOwnership(target: object, marker: symbol): void {
	if (!Reflect.deleteProperty(target, marker)) {
		throw new TypeError("Unable to release CDP resource ownership")
	}
}
