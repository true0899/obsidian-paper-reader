import type { HighlightRect } from "../storage/annotationStore";

export interface SelectionSegment {
	page: number;
	rects: HighlightRect[];
	text: string;
	textOffset: number;
	contextBefore: string;
	contextAfter: string;
}

export interface SelectionPayload {
	/** Document-ordered page selections; absent on legacy single-page payloads. */
	segments?: SelectionSegment[];
	page: number;
	rects: HighlightRect[];
	text: string;
	textOffset: number;
	contextBefore: string;
	contextAfter: string;
	/** viewport coords of the selection end, used to position the toolbar */
	anchorRect: DOMRect;
}

const CONTEXT_LEN = 32;

/** Whether two unscaled page rects overlap (with a small tolerance). */
export function rectsOverlap(a: HighlightRect, b: HighlightRect): boolean {
	const tol = 1;
	return (
		a.x < b.x + b.width - tol &&
		a.x + a.width > b.x + tol &&
		a.y < b.y + b.height - tol &&
		a.y + a.height > b.y + tol
	);
}

function elementOf(node: Node | null): Element | null {
	if (!node) return null;
	return node.nodeType === Node.ELEMENT_NODE
		? (node as Element)
		: node.parentElement;
}

/** Caret (collapsed range) rect at a DOM position — reliable even inside
 *  scaled spans, unlike Range.getClientRects() on transformed elements. */
function caretRect(node: Node, offset: number): DOMRect | null {
	const r = node.ownerDocument!.createRange();
	r.setStart(node, offset);
	r.collapse(true);
	const rects = r.getClientRects();
	return rects.length > 0 ? rects[0] : null;
}

export interface RectLike {
	left: number;
	top: number;
	width: number;
	height: number;
	bottom?: number;
}

/** Single-line selection band from caret positions; null if not single-line. */
export function buildSingleLineRect(
	startCaret: RectLike,
	endCaret: RectLike
): RectLike | null {
	if (Math.abs(startCaret.top - endCaret.top) >= Math.max(startCaret.height, 1) * 0.5) {
		return null;
	}
	const width = endCaret.left - startCaret.left;
	if (width <= 0 || startCaret.height < 2) return null;
	return {
		left: startCaret.left,
		top: startCaret.top,
		width,
		height: startCaret.height,
	};
}

/**
 * Multi-line rect cleanup: keep rects inside the caret-bounded vertical band,
 * drop oversized boxes from transformed spans, dedupe near-duplicate pairs.
 */
export function filterMultiLineRects<T extends RectLike>(
	raw: T[],
	bandTop: number,
	bandBottom: number,
	lineH: number
): T[] {
	const kept: T[] = [];
	for (const r of raw) {
		const bottom = r.bottom ?? r.top + r.height;
		if (r.width < 2 || r.height < 2) continue;
		if (bottom < bandTop || r.top > bandBottom) continue;
		if (lineH > 0 && r.height > lineH * 2.5) continue;
		if (kept.some((k) => Math.abs(k.top - r.top) < 4 && Math.abs(k.left - r.left) < 4))
			continue;
		kept.push(r);
	}
	return kept;
}

/** Rejoin adjacent glyph cells into line bands, retaining gaps between columns. */
export function mergeTextRects(raw: RectLike[]): RectLike[] {
	const merged: RectLike[] = [];
	for (const rect of [...raw].sort((a, b) => a.top - b.top || a.left - b.left)) {
		const last = merged[merged.length - 1];
		if (last && Math.abs(last.top - rect.top) < 1 && Math.abs(last.height - rect.height) < 1 &&
			rect.left <= last.left + last.width + Math.max(1, rect.height / 2)) {
			last.width = Math.max(last.left + last.width, rect.left + rect.width) - last.left;
		} else merged.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
	}
	return merged;
}

/** Text boxes only: a DOM Range may also include duplicate transformed span boxes. */
export function textRangeRects(range: Range, root: Node): DOMRect[] {
	const rects: DOMRect[] = [];
	const doc = root.ownerDocument!;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (!node.textContent?.trim() || !range.intersectsNode(node)) continue;
		const part = doc.createRange();
		part.selectNodeContents(node);
		if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
			part.setStart(range.startContainer, range.startOffset);
		}
		if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
			part.setEnd(range.endContainer, range.endOffset);
		}
		if (!part.collapsed) rects.push(...Array.from(part.getClientRects()));
	}
	return rects;
}

/** Clip adjacent selection lines at their midpoint so translucent fills never stack. */
export function separateSelectionLines(rects: HighlightRect[]): HighlightRect[] {
	const lines: { center: number; rects: HighlightRect[] }[] = [];
	for (const rect of [...rects].sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2)) {
		const center = rect.y + rect.height / 2;
		const line = lines.find((item) =>
			Math.abs(item.center - center) < Math.min(item.rects[0].height, rect.height) / 2
		);
		if (line) line.rects.push(rect);
		else lines.push({ center, rects: [rect] });
	}
	return lines.flatMap((line, index) => {
		const top = index > 0 ? (lines[index - 1].center + line.center) / 2 : -Infinity;
		const bottom = index + 1 < lines.length
			? (line.center + lines[index + 1].center) / 2
			: Infinity;
		return line.rects.map((rect) => {
			const y = Math.max(rect.y, top);
			return { ...rect, y, height: Math.max(0, Math.min(rect.y + rect.height, bottom) - y) };
		}).filter((rect) => rect.height > 0);
	});
}

/** Tighten the line-box leading above glyphs without moving its bottom edge.
 * Stored geometry is retained; this also fixes older overlapping highlights.
 */
export function highlightDisplayRects(rects: HighlightRect[]): HighlightRect[] {
	return separateSelectionLines(rects.map(rect => ({
		...rect,
		y: rect.y + rect.height * 0.08,
		height: rect.height * 0.92,
	})));
}

/**
 * Draw the active selection with line-safe bands over the PDF page. The native
 * highlight is suppressed in CSS for the whole text layer; this overlay
 * supplies visible feedback while the selection is active.
 * `pr-selection-preview` is a bookkeeping marker for "this page currently
 * shows a preview", used to skip untouched pages on repaint.
 */
export function renderSelectionPreview(layer: HTMLElement, rects: HighlightRect[], scale: number): void {
	layer.replaceChildren();
	layer.parentElement?.classList.toggle("pr-selection-preview", rects.length > 0);
	for (const rect of highlightDisplayRects(rects)) {
		const el = layer.createDiv({ cls: "pr-selection-rect" });
		el.setCssStyles({ backgroundColor: "rgba(122, 96, 255, 0.35)" });
		el.style.left = `${rect.x * scale}px`;
		el.style.top = `${rect.y * scale}px`;
		el.style.width = `${rect.width * scale}px`;
		el.style.height = `${rect.height * scale}px`;
	}
}

/** Include position so repeated quotations do not share popup state. */
export function selectionIdentity(payload: SelectionPayload): string {
	return JSON.stringify((payload.segments ?? [payload]).map(part =>
		[part.page, part.textOffset, part.text, part.rects]));
}

export function sameSelection(a: SelectionPayload | null, b: SelectionPayload | null): boolean {
	return !!a && !!b && selectionIdentity(a) === selectionIdentity(b);
}

/** Offset at a DOM endpoint using the mapping assigned by the renderer. */
function pageOffset(layer: HTMLElement, node: Node, offset: number): number {
	const span = elementOf(node)?.closest<HTMLElement>("[data-pr-text-start]");
	if (span && layer.contains(span)) {
		const prefix = layer.ownerDocument.createRange();
		prefix.selectNodeContents(span);
		prefix.setEnd(node, offset);
		return Number(span.dataset.prTextStart) + prefix.toString().length;
	}
	const prefix = layer.ownerDocument.createRange();
	prefix.selectNodeContents(layer);
	prefix.setEnd(node, offset);
	const boundary = Range.END_TO_END;
	let result = 0;
	for (const div of Array.from(layer.querySelectorAll<HTMLElement>("[data-pr-text-start]"))) {
		const item = layer.ownerDocument.createRange();
		item.selectNodeContents(div);
		if (item.compareBoundaryPoints(boundary, prefix) > 0) break;
		result = Number(div.dataset.prTextEnd);
	}
	// Legacy renderers have no mapping; preserve their concatenated DOM offset.
	return layer.querySelector("[data-pr-text-start]") ? result : prefix.toString().length;
}

/** Caret range for editing an existing annotation endpoint. */
export function rangeFromPageTextOffset(layer: Element, offset: number, end = false): Range | null {
	const divs = Array.from(layer.querySelectorAll<HTMLElement>("[data-pr-text-start]"));
	for (let i = 0; i < divs.length; i++) {
		const div = divs[i], node = div.firstChild;
		if (node?.nodeType !== Node.TEXT_NODE) continue;
		if (offset < Number(div.dataset.prTextEnd) || (end && offset === Number(div.dataset.prTextEnd)) || i === divs.length - 1) {
			const range = layer.ownerDocument.createRange();
			range.setStart(node, Math.max(0, Math.min(offset - Number(div.dataset.prTextStart), node.textContent?.length ?? 0)));
			range.collapse(true);
			return range;
		}
	}
	return null;
}

/** Search offsets use the same mapped spans as selection, including synthetic line breaks. */
export function domRangeForText(layer: Element, index: number, length: number): Range | null {
	const divs = Array.from(layer.querySelectorAll<HTMLElement>("[data-pr-text-start]"));
	if (!divs.length || length <= 0) return null;
	const point = (position: number, end: boolean): [Node, number] | null => {
		const ordered = end ? [...divs].reverse() : divs;
		for (const div of ordered) {
			const start = Number(div.dataset.prTextStart), finish = Number(div.dataset.prTextEnd);
			if (end ? position > start : position < finish) {
				const node = div.firstChild;
				if (node?.nodeType === Node.TEXT_NODE) return [node, Math.max(0, Math.min(position - start, node.textContent?.length ?? 0))];
			}
		}
		return null;
	};
	const start = point(index, false), end = point(index + length, true);
	if (!start || !end) return null;
	const range = layer.ownerDocument.createRange();
	range.setStart(...start); range.setEnd(...end);
	return range;
}

/** Visible selection geometry clipped to one page. */
export function selectionRectsForPage(
	selection: Selection,
	pageEl: HTMLElement,
	scale: number
): HighlightRect[] {
	if (selection.isCollapsed || selection.rangeCount === 0) return [];
	const fullRange = selection.getRangeAt(0);
	if (!fullRange.intersectsNode(pageEl)) return [];
	const layer = pageEl.querySelector(".textLayer") ?? pageEl;
	const range = pageEl.ownerDocument.createRange();
	range.selectNodeContents(layer);
	if (range.compareBoundaryPoints(Range.START_TO_START, fullRange) < 0) range.setStart(fullRange.startContainer, fullRange.startOffset);
	if (range.compareBoundaryPoints(Range.END_TO_END, fullRange) > 0) range.setEnd(fullRange.endContainer, fullRange.endOffset);
	const text = range.toString();
	const pageRect = pageEl.getBoundingClientRect();
	const toPageRect = (
		left: number,
		top: number,
		width: number,
		height: number
	): HighlightRect | null => {
		// clip to page bounds (cross-page bleed) and skip slivers
		const l = Math.max(left, pageRect.left);
		const t = Math.max(top, pageRect.top);
		const r = Math.min(left + width, pageRect.right);
		const b = Math.min(top + height, pageRect.bottom);
		const w = r - l;
		const h = b - t;
		if (w <= 0 || h < 2) return null;
		// Line-box height includes leading; trim ~10% top and bottom so
		// highlight bands hug the glyphs and don't overlap adjacent lines.
		const trim = h * 0.1;
		return {
			x: (l - pageRect.left) / scale,
			y: (t + trim - pageRect.top) / scale,
			width: w / scale,
			height: (h - 2 * trim) / scale,
		};
	};

	// Caret rects at both ends of the (document-ordered) range.
	const startCaret = caretRect(range.startContainer, range.startOffset);
	const endCaret = caretRect(range.endContainer, range.endOffset);
	const singleLineRect =
		pageEl.contains(range.startContainer) && pageEl.contains(range.endContainer) &&
		!text.includes("\n") && startCaret && endCaret
			? buildSingleLineRect(startCaret, endCaret)
			: null;

	const rects: HighlightRect[] = [];
	if (singleLineRect) {
		// Exact single-line band from caret positions. This avoids the
		// pathological multi-line boxes Range.getClientRects() returns for
		// spans with CSS transforms (rotated/scaled text), where the whole
		// block would otherwise be covered by a one-line selection.
		const rect = toPageRect(
			singleLineRect.left,
			singleLineRect.top,
			singleLineRect.width,
			singleLineRect.height
		);
		if (rect) rects.push(rect);
	} else {
		// A range spanning whole PDF spans includes both element and text boxes.
		// Measure selected text nodes only, so each glyph run is counted once.
		const raw = textRangeRects(range, pageEl.querySelector(".textLayer") ?? pageEl);
		// Text-node ranges already clip endpoints. A vertical caret band would
		// discard selected lines when a range crosses two columns or pages.
		const bandTop = pageRect.top - 2;
		const bandBottom = pageRect.bottom + 2;
		const lineH = Math.max(startCaret?.height ?? 0, endCaret?.height ?? 0);
		const kept = filterMultiLineRects(
			mergeTextRects(raw),
			bandTop,
			bandBottom,
			lineH
		);
		const source =
			kept.length > 0
				? kept
				: // fallback: unfiltered (e.g. rotated text where caret heights
				  // are degenerate); better a rough box than no annotation
				  raw;
		for (const r of source) {
			const rect = toPageRect(r.left, r.top, r.width, r.height);
			if (rect) rects.push(rect);
		}
	}
	return rects;
}

/** Map each selected page independently, using ordered DOM endpoints. */
export function selectionToPayload(
	selection: Selection,
	scale: number,
	getPageText: (page: number) => string | undefined
): SelectionPayload | null {
	if (selection.isCollapsed || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	const startPage = elementOf(range.startContainer)?.closest<HTMLElement>(".pr-page");
	const endPage = elementOf(range.endContainer)?.closest<HTMLElement>(".pr-page");
	const pages = startPage?.closest<HTMLElement>(".pr-pages") ?? startPage?.parentElement;
	if (!startPage || !endPage || !pages || !pages.contains(endPage)) return null;
	const segments: SelectionSegment[] = [];
	for (const pageEl of Array.from(pages.querySelectorAll<HTMLElement>(".pr-page"))) {
		if (!range.intersectsNode(pageEl)) continue;
		const layer = pageEl.querySelector<HTMLElement>(".textLayer");
		const page = Number(pageEl.dataset.pageNumber);
		if (!layer || !Number.isFinite(page)) continue;
		const part = layer.ownerDocument.createRange();
		part.selectNodeContents(layer);
		if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0) part.setStart(range.startContainer, range.startOffset);
		if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0) part.setEnd(range.endContainer, range.endOffset);
		if (part.collapsed) continue;
		const pageText = getPageText(page) ?? "";
		const offset = pageOffset(layer, part.startContainer, part.startOffset);
		const end = pageOffset(layer, part.endContainer, part.endOffset);
		const text = pageText ? pageText.slice(offset, end) : part.toString();
		const rects = selectionRectsForPage(selection, pageEl, scale);
		if (!text.trim() || !rects.length) continue;
		segments.push({ page, rects, text, textOffset: offset,
			contextBefore: pageText.slice(Math.max(0, offset - CONTEXT_LEN), offset),
			contextAfter: pageText.slice(end, end + CONTEXT_LEN) });
	}
	if (!segments.length) return null;
	return { ...segments[0], segments, text: segments.map(part => part.text).join("\n"),
		anchorRect: range.getBoundingClientRect() };
}
