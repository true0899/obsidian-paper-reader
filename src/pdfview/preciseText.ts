/// <reference lib="es2022.intl" />
import type { PDFOperatorList, TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

type Operators = Record<"save" | "restore" | "setFont" | "showText" |
	"setCharSpacing" | "setWordSpacing" | "setGState", number> &
	Partial<Record<"paintFormXObjectBegin" | "paintFormXObjectEnd" | "beginGroup" | "endGroup", number>>;
type Glyph = { text: string; start: number; end: number };
type Run = { glyphs: Glyph[]; width: number };
const keyOf = (font: string, text: string) => `${font}:${text.replace(/\s/g, "")}`;

/** Read PDF advances (including TJ kerning) without interpreting page coordinates.
 * ponytail: exact whole-run matches only; add positional matching if split runs need it.
 * TextContent supplies their page transform; uncertain runs keep PDF.js's layout.
 * Embedded fonts cannot simply be applied to Unicode: PDF.js remaps their glyphs.
 */
export function preciseTextContent(content: TextContent, list: PDFOperatorList, ops: Operators): {
	content: TextContent; glyphItems: Map<TextItem, TextItem>;
} {
	const runs = new Map<string, Map<string, Run>>();
	let state = { font: "", size: 0, char: 0, word: 0 };
	const stack: typeof state[] = [];
	for (let i = 0; i < list.fnArray.length; i++) {
		const op = list.fnArray[i];
		const args = list.argsArray[i] as unknown[];
		if (op === ops.save || op === ops.paintFormXObjectBegin || op === ops.beginGroup) stack.push({ ...state });
		else if (op === ops.restore || op === ops.paintFormXObjectEnd || op === ops.endGroup) {
			state = stack.pop() ?? { font: "", size: 0, char: 0, word: 0 };
		} else if (op === ops.setFont) {
			state.font = String(args[0]); state.size = Number(args[1]);
		} else if (op === ops.setCharSpacing) state.char = Number(args[0]);
		else if (op === ops.setWordSpacing) state.word = Number(args[0]);
		else if (op === ops.setGState && Array.isArray(args[0])) {
			for (const [name, value] of args[0] as [string, unknown][]) {
				if (name === "Font" && Array.isArray(value)) {
					state.font = String(value[0]); state.size = Number(value[1]);
				}
			}
		} else if (op === ops.showText && state.size > 0 && Array.isArray(args[0])) {
			let x = 0;
			const glyphs: Glyph[] = [];
			for (const value of args[0] as unknown[]) {
				if (typeof value === "number") { x -= value / 1000; continue; }
				if (!value || typeof value !== "object") { x = NaN; break; }
				const g = value as { unicode?: unknown; width?: unknown; isSpace?: boolean };
				if (typeof g.unicode !== "string" || typeof g.width !== "number") { x = NaN; break; }
				const start = x;
				x += g.width / 1000 + (state.char + (g.isSpace ? state.word : 0)) / state.size;
				glyphs.push({ text: g.unicode.normalize("NFKC"), start, end: x });
			}
			if (!glyphs.length || !Number.isFinite(x)) continue;
			const origin = glyphs[0].start;
			const run = { glyphs: glyphs.map(g => ({ ...g, start: g.start - origin, end: g.end - origin })), width: x - origin };
			const key = keyOf(state.font, glyphs.map(g => g.text).join(""));
			const candidates = runs.get(key) ?? new Map<string, Run>();
			// Repeated identical text usually shares metrics; avoid quadratic matching.
			candidates.set(JSON.stringify(run), run);
			runs.set(key, candidates);
		}
	}

	const glyphItems = new Map<TextItem, TextItem>();
	// PDF.js stops at 100,000 text divs. Expansion must never truncate page text.
	let extraItems = Math.max(0, 100_000 - content.items.length);
	const items = content.items.flatMap(item => {
		if (!("str" in item) || !item.str || item.dir !== "ltr" || content.styles[item.fontName]?.vertical) return [item];
		const [a, b, c, d, x, y] = item.transform as number[];
		const scale = Math.hypot(a, b);
		if (!(scale > 0) || ![a, b, c, d, x, y, item.width].every(Number.isFinite)) return [item];
		const matches = [...(runs.get(keyOf(item.fontName, item.str))?.values() ?? [])].filter(run =>
			Math.abs(run.width * scale - item.width) <= Math.max(0.02, item.width * 0.0001));
		if (matches.length !== 1) return [item];
		const run = matches[0];
		const parts: Glyph[] = [];
		let offset = 0, previousEnd = 0;
		for (const glyph of run.glyphs) {
			if (!glyph.text) return [item];
			// getTextContent synthesizes spaces for sufficiently large TJ gaps.
			if (!/^\s/.test(glyph.text)) {
				const space = /^\s+/.exec(item.str.slice(offset))?.[0];
				if (space) {
					parts.push({ text: space, start: previousEnd, end: glyph.start });
					offset += space.length;
				}
			}
			if (!item.str.startsWith(glyph.text, offset)) return [item];
			parts.push({ ...glyph }); offset += glyph.text.length; previousEnd = glyph.end;
		}
		if (offset !== item.str.length) return [item];
		// Each selectable cell ends at the next glyph's origin, including kerning.
		for (let i = 0; i < parts.length - 1; i++) parts[i].end = parts[i + 1].start;
		if (parts.some(p => !(p.end > p.start))) return [item];
		if (parts.length - 1 > extraItems) return [item];
		extraItems -= parts.length - 1;
		return parts.map((part, i): TextItem => {
			const glyph = { ...item, str: part.text, width: (part.end - part.start) * scale,
				transform: [a, b, c, d, x + part.start * a, y + part.start * b],
				hasEOL: i === parts.length - 1 && item.hasEOL };
			glyphItems.set(glyph, item);
			return glyph;
		});
	});
	return { content: { ...content, items }, glyphItems };
}

export interface PageTextMapping {
	text: string;
	items: { start: number; end: number; domStart: number; domEnd: number }[];
}

/** Shared offsets for extracted page text, rendered spans and search results. */
export function buildPageText(items: readonly ({ str: string; hasEOL?: boolean } | object)[]): PageTextMapping {
	let text = "", domOffset = 0;
	const mapped: PageTextMapping["items"] = [];
	for (const item of items) {
		if (!("str" in item) || typeof item.str !== "string") continue;
		const start = text.length;
		text += item.str;
		mapped.push({ start, end: text.length, domStart: domOffset, domEnd: domOffset + item.str.length });
		domOffset += item.str.length;
		if ("hasEOL" in item && item.hasEOL) text += "\n";
	}
	return { text, items: mapped };
}

/** Expand words across neighbouring PDF text spans; preserve native handling for RTL/rotation. */
export function preserveWordSelection(layer: HTMLElement, _groups: HTMLElement[][]): void {
	const doc = layer.ownerDocument;
	const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
	type Point = [Node, number];
	type Unit = { start: Point; end: Point };
	let anchor: Unit | null = null, granularity = 2;
	const caretAt = (x: number, y: number): Range | null => {
		const api = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
		return api.caretRangeFromPoint?.(x, y) ?? null;
	};
	const unitAt = (x: number, y: number, clicks: number): Unit | null => {
		const caret = caretAt(x, y);
		const target = caret?.startContainer.parentElement?.closest<HTMLElement>("span");
		const reader = layer.closest(".pr-pages") ?? layer;
		const targetLayer = target?.closest<HTMLElement>(".textLayer");
		if (!caret || !target || !targetLayer || !reader.contains(target) || target.dir === "rtl") return null;
		const rotation = target.style.getPropertyValue("--rotate");
		if (rotation && parseFloat(rotation) !== 0) return null;
		const rect = target.getBoundingClientRect();
		if (Math.abs(rect.height) < 1) return null;
		const spans = Array.from(targetLayer.querySelectorAll<HTMLElement>("span"))
			.filter(div => div.firstChild?.nodeType === Node.TEXT_NODE && div.dir !== "rtl");
		const selected: HTMLElement[] = [target];
		const at = spans.indexOf(target);
		if (at < 0) return null;
		const adjacent = (a: HTMLElement, b: HTMLElement): boolean => {
			const left = a.getBoundingClientRect(), right = b.getBoundingClientRect();
			return Math.abs(left.top - right.top) < Math.min(left.height, right.height) * 0.4 &&
				right.left >= left.left && right.left - left.right < Math.max(left.height, right.height);
		};
		for (let i = at - 1; i >= 0 && adjacent(spans[i], selected[0]); i--) selected.unshift(spans[i]);
		for (let i = at + 1; i < spans.length && adjacent(selected[selected.length - 1], spans[i]); i++) selected.push(spans[i]);
		let text = "", offset = 0;
		const starts: number[] = [];
		for (let i = 0; i < selected.length; i++) {
			const div = selected[i];
			if (i && div.getBoundingClientRect().left - selected[i - 1].getBoundingClientRect().right > rect.height * 0.2) text += " ";
			starts.push(text.length);
			if (div === target) offset = text.length + Math.max(0, caret.startOffset -
				(caret.startOffset === (caret.startContainer.textContent?.length ?? 0) ? 1 : 0));
			text += div.textContent ?? "";
		}
		const point = (position: number, end: boolean): Point => {
			for (let i = 0; i < selected.length; i++) {
				const node = selected[i].firstChild!;
				const finish = starts[i] + (node.textContent?.length ?? 0);
				if (position < finish || (end && position === finish) || i === selected.length - 1)
					return [node, Math.max(0, Math.min(position - starts[i], node.textContent?.length ?? 0))];
			}
			return [target.firstChild!, 0];
		};
		if (clicks >= 3) return { start: point(0, false), end: point(text.length, true) };
		const word = segmenter.segment(text).containing(Math.min(offset, text.length - 1));
		return word ? { start: point(word.index, false), end: point(word.index + word.segment.length, true) } : null;
	};
	const apply = (unit: Unit): void => {
		const range = doc.createRange();
		range.setStart(...unit.start); range.setEnd(...unit.end);
		const selection = doc.getSelection();
		selection?.removeAllRanges(); selection?.addRange(range);
	};
	layer.addEventListener("mousedown", event => {
		stop();
		if (event.button !== 0 || event.detail < 2) return;
		granularity = event.detail;
		anchor = unitAt(event.clientX, event.clientY, granularity);
		if (anchor) {
			event.preventDefault(); apply(anchor);
			doc.addEventListener("mousemove", move);
			doc.addEventListener("mouseup", stop, { once: true });
		}
	});
	const move = (event: MouseEvent): void => {
		if (!anchor || !(event.buttons & 1)) return;
		const focus = unitAt(event.clientX, event.clientY, granularity);
		if (!focus) return;
		const a = doc.createRange(), b = doc.createRange();
		a.setStart(...anchor.start); a.collapse(true);
		b.setStart(...focus.start); b.collapse(true);
		const backwards = b.compareBoundaryPoints(Range.START_TO_START, a) < 0;
		apply(backwards ? { start: focus.start, end: anchor.end } : { start: anchor.start, end: focus.end });
		event.preventDefault();
	};
	const stop = (): void => { anchor = null; doc.removeEventListener("mousemove", move); };
	// The browser's dblclick default would otherwise replace our cross-span range.
	layer.addEventListener("dblclick", event => {
		const unit = unitAt(event.clientX, event.clientY, 2);
		if (unit) { event.preventDefault(); apply(unit); }
	});
}
