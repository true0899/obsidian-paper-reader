import { t } from "../i18n";

export const MIN_INK_WIDTH = 0.5;
export const MAX_INK_WIDTH = 20;

/** Shared pen/annotation controls. Preview while dragging; commit one change. */
export function createInkWidthControl(parent: HTMLElement, initial: number,
	onWidth: (width: number, commit: boolean) => void | Promise<void>): () => void | Promise<void> {
	let value = Math.max(MIN_INK_WIDTH, Math.min(MAX_INK_WIDTH, initial));
	let pending = false;
	const row = parent.createDiv({ cls: "pr-ink-width-control" });
	row.createSpan({ text: t("线宽") });
	const slider = row.createEl("input", { cls: "pr-ink-width-slider", attr: {
		type: "range", min: String(MIN_INK_WIDTH), max: String(MAX_INK_WIDTH), step: "0.1", "aria-label": t("线宽滑动条") } });
	const number = row.createEl("input", { cls: "pr-ink-width-number", attr: {
		type: "number", min: String(MIN_INK_WIDTH), max: String(MAX_INK_WIDTH), step: "0.1", "aria-label": t("线宽数值") } });
	row.createSpan({ text: "pt" });
	const preview = parent.createDiv({ cls: "pr-ink-width-preview", attr: { "aria-hidden": "true" } });
	const line = preview.createSpan({ cls: "pr-ink-width-line" });
	const sync = () => { slider.value = number.value = String(value); line.style.borderTopWidth = `${value}px`; };
	const flush = () => { if (pending) { pending = false; return onWidth(value, true); } };
	const read = (input: HTMLInputElement, commit: boolean) => {
		const raw = input.value.trim();
		const parsed = Number(raw);
		if (!raw || !Number.isFinite(parsed) || (!commit && (parsed < MIN_INK_WIDTH || parsed > MAX_INK_WIDTH))) {
			if (commit) { sync(); flush(); } return;
		}
		const next = Math.round(Math.max(MIN_INK_WIDTH, Math.min(MAX_INK_WIDTH, parsed)) * 10) / 10;
		if (value !== next) { value = next; pending = true; onWidth(value, false); }
		sync(); if (commit) flush();
	};
	for (const input of [slider, number]) {
		input.addEventListener("input", () => read(input, false));
		input.addEventListener("change", () => read(input, true));
		input.addEventListener("blur", () => read(input, true));
		input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); read(input, true); } });
	}
	const presets = parent.createDiv({ cls: "pr-popup-widths" });
	for (const [label, width] of [[t("细"), 2], [t("中"), 4], [t("粗"), 7]] as const) {
		const button = presets.createEl("button", { cls: "pr-popup-width-btn", text: label, attr: { type: "button" } });
		button.addEventListener("click", () => { number.value = String(width); read(number, true); });
	}
	sync(); return flush;
}
