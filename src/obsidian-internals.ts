import { TFile } from "obsidian";

/** Undocumented host APIs are optional and validated in this adapter only. */
export interface ExtensionViewRegistry {
	typeByExtension: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function getExtensionViewRegistry(app: unknown): ExtensionViewRegistry | null {
	if (!isObject(app) || !isObject(app.viewRegistry)) return null;
	const mapping = app.viewRegistry.typeByExtension;
	if (!isObject(mapping) || Array.isArray(mapping)) return null;
	if (!Object.values(mapping).every(value => typeof value === "string")) return null;
	return { typeByExtension: mapping as Record<string, string> };
}

export function getViewFile(view: unknown): TFile | null {
	return isObject(view) && view.file instanceof TFile ? view.file : null;
}

export function refreshLeafHeader(leaf: unknown): void {
	if (!isObject(leaf) || typeof leaf.updateHeader !== "function") return;
	// Header updates are cosmetic. A changed internal API must not break PDF opening.
	try { leaf.updateHeader.call(leaf); } catch { /* Unsupported host internals. */ }
}
