import { mergeTextRects } from "../pdfview/selection";
import type { HighlightRect } from "../storage/annotationStore";

/** Index the rendered text once; each match visits only the glyphs it covers. */
export function pageSearchGeometry(wrapper: HTMLElement): (index: number, length: number) => HighlightRect[] {
	const bounds = wrapper.getBoundingClientRect();
	const spans = Array.from(wrapper.querySelectorAll<HTMLElement>(".textLayer [data-pr-text-start]"))
		.map(span => ({ node: span.firstChild, start: Number(span.dataset.prTextStart), end: Number(span.dataset.prTextEnd) }))
		.filter((span): span is { node: Text; start: number; end: number } => span.node?.nodeType === 3);
	return (index, length) => {
		const end = index + length;
		let low = 0, high = spans.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (spans[mid].end <= index) low = mid + 1;
			else high = mid;
		}
		const rects: DOMRect[] = [];
		for (let i = low; i < spans.length && spans[i].start < end; i++) {
			const span = spans[i], size = span.node.length;
			const startOffset = Math.max(0, Math.min(size, index - span.start));
			const endOffset = Math.max(0, Math.min(size, end - span.start));
			if (endOffset <= startOffset) continue;
			const range = wrapper.ownerDocument.createRange();
			range.setStart(span.node, startOffset); range.setEnd(span.node, endOffset);
			rects.push(...Array.from(range.getClientRects()));
		}
		return mergeTextRects(rects).filter(r => r.width >= 2 && r.height >= 2)
			.map(r => ({ x: r.left - bounds.left, y: r.top - bounds.top, width: r.width, height: r.height }));
	};
}
