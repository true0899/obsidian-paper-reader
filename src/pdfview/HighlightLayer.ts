import { setIcon } from "obsidian";
import type { Annotation, HighlightRect } from "../storage/annotationStore";
import { highlightDisplayRects } from "./selection";

export type HighlightClickHandler = (
	annotation: Annotation,
	clientX: number,
	clientY: number
) => void;

const pageClickHandlers = new WeakMap<HTMLElement, EventListener>();

function hexToRgba(hex: string, alpha: number): string {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = parseInt(m[1], 16);
	const r = (n >> 16) & 0xff;
	const g = (n >> 8) & 0xff;
	const b = n & 0xff;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** repeating SVG wave used as background-image for wavy annotations */
function wavyBackground(color: string, scale: number): string {
	// A centered, shallow wave leaves room for both crests and troughs.
	// Keep the geometry in PDF units so zoom does not change its proportions.
	const w = 10 * scale;
	const h = 4 * scale;
	const svg =
		`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 10 4'>` +
		`<path d='M0 2 C1.667 .667 3.333 .667 5 2 C6.667 3.333 8.333 3.333 10 2' ` +
		`fill='none' stroke='${color}' stroke-width='.85'/></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function styleRect(
	el: HTMLElement,
	ann: Annotation,
	colorHex: string,
	scale: number
): void {
	// Annotation bands must join with square edges, including note fills.
	el.style.borderRadius = "0";
	const style = ann.style ?? "highlight";
	if (ann.type === "note") {
		// notes: light fill, distinct from highlights
		el.style.backgroundColor = hexToRgba(colorHex, 0.18);
		el.addClass("pr-note-rect");
		return;
	}
	if (style === "underline") {
		el.style.borderBottom = `${Math.max(1.5, 2 * scale)}px solid ${colorHex}`;
		el.addClass("pr-line-rect");
	} else if (style === "wavy") {
		el.style.backgroundImage = wavyBackground(colorHex, scale);
		el.setCssStyles({ backgroundRepeat: "repeat-x", backgroundPosition: "bottom left" });
		el.addClass("pr-line-rect");
	} else if (style === "strikethrough") {
		// solid line at the vertical middle of each line rect
		const thickness = Math.max(1.5, 2 * scale);
		el.style.backgroundImage = `linear-gradient(${colorHex}, ${colorHex})`;
		el.setCssStyles({ backgroundRepeat: "no-repeat", backgroundPosition: "0 50%" });
		el.style.backgroundSize = `100% ${thickness}px`;
		el.addClass("pr-line-rect");
	} else {
		el.style.backgroundColor = hexToRgba(colorHex, 1);
		el.setCssStyles({ mixBlendMode: "multiply" });
	}
}

/** Render overlay rects for all annotations of one page (one rect per line). */
export function renderHighlightRects(
	layerEl: HTMLElement,
	annotations: Annotation[],
	scale: number,
	colors: Record<string, string>,
	onClick: HighlightClickHandler,
	selectedIds: readonly string[] = []
): void {
	layerEl.empty();
	const pageEl = layerEl.parentElement;
	const previousClickHandler = pageEl && pageClickHandlers.get(pageEl);
	if (pageEl && previousClickHandler) {
		pageEl.removeEventListener("click", previousClickHandler);
	}
	if (pageEl) {
		const clickHandler = (event: Event): void => {
			const e = event as MouseEvent;
			const selection = pageEl.ownerDocument.getSelection();
			if (selection && !selection.isCollapsed && selection.toString().trim()) return;
			const pageRect = pageEl.getBoundingClientRect();
			const x = (e.clientX - pageRect.left) / scale;
			const y = (e.clientY - pageRect.top) / scale;
			const annotation = [...annotations].reverse().find((ann) =>
				ann.rects.some(
					(rect) =>
						x >= rect.x &&
						x <= rect.x + rect.width &&
						y >= rect.y &&
						y <= rect.y + rect.height
				)
			);
			if (annotation) onClick(annotation, e.clientX, e.clientY);
		};
		pageEl.addEventListener("click", clickHandler);
		pageClickHandlers.set(pageEl, clickHandler);
	}
	for (const ann of annotations) {
		const color = colors[ann.color] ?? ann.color;
		const displayRects = ann.type === "highlight" && (ann.style ?? "highlight") === "highlight"
			? highlightDisplayRects(ann.rects) : ann.rects;
		for (const rect of displayRects) {
			const el = layerEl.createDiv({ cls: "pr-highlight-rect" });
			el.dataset.annotationId = ann.id;
			el.style.left = `${rect.x * scale}px`;
			el.style.top = `${rect.y * scale}px`;
			el.style.width = `${rect.width * scale}px`;
			el.style.height = `${rect.height * scale}px`;
			styleRect(el, ann, color, scale);
		}
		if (selectedIds.includes(ann.id) && ann.rects.length) {
			const left = Math.min(...displayRects.map(r => r.x));
			const top = Math.min(...displayRects.map(r => r.y));
			const right = Math.max(...displayRects.map(r => r.x + r.width));
			const bottom = Math.max(...displayRects.map(r => r.y + r.height));
			const selected = layerEl.createDiv({ cls: "pr-highlight-selection" });
			selected.dataset.annotationId = ann.id;
			selected.setCssStyles({ left: `${left * scale}px`, top: `${top * scale}px`, width: `${(right - left) * scale}px`, height: `${(bottom - top) * scale}px` });
		}
		// note marker icon at the end of the last rect
		if (ann.type === "note" && ann.rects.length > 0) {
			const last = ann.rects[ann.rects.length - 1];
			const icon = layerEl.createEl("button", { cls: "pr-note-icon", attr: { "aria-label": "编辑或删除批注", title: ann.note ?? "批注" } });
			setIcon(icon, "message-square");
			icon.style.left = `${(last.x + last.width) * scale + 2}px`;
			icon.style.top = `${last.y * scale - 2}px`;
			icon.addEventListener("click", (e) => {
				e.stopPropagation();
				onClick(ann, e.clientX, e.clientY);
			});
		}
	}
}

export type { HighlightRect };
