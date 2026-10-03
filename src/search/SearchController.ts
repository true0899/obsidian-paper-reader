import { t } from "../i18n";
import { findHits, type SearchHit } from "./searchText";
import { mergeTextRects, textRangeRects } from "../pdfview/selection";
import type { PdfRenderer, RenderedPage } from "../pdfview/PdfRenderer";
import type { HighlightRect } from "../storage/annotationStore";

export interface SearchState {
	token: number;
	hits: SearchHit[];
	current: number;
}
interface SearchDependencies {
	renderer: PdfRenderer;
	input: () => HTMLInputElement | null;
	count: () => HTMLElement | null;
	hasFile: () => boolean;
	pages: () => RenderedPage[];
	scale: () => number;
	clearHighlights: () => void;
	rememberNavigation: () => void;
	scrollToPage: (page: number) => Promise<void>;
	domRangeForText: (wrapper: HTMLElement, start: number, length: number) => Range | null;
	scrollToRect: (page: number, rect: HighlightRect) => void;
}

/** Document search scanning and hit navigation. A token invalidates outstanding
 * extraction/navigation when the view closes or changes documents. */
export class SearchController {
	constructor(private state: SearchState, private deps: SearchDependencies) {}
	async run(): Promise<void> {
		const token = ++this.state.token;
		this.deps.clearHighlights();
		this.state.hits = [];
		this.state.current = -1;
		const query = this.deps.input()?.value ?? "";
		const countEl = this.deps.count();
		if (!this.deps.hasFile() || !query.trim()) {
			if (countEl) countEl.setText("");
			return;
		}
		if (countEl) countEl.setText(t("搜索中…"));
		const n = this.deps.renderer.numPages;
		let hasText = false;
		for (let p = 1; p <= n; p++) {
			if (token !== this.state.token) return;
			let text = "";
			try { text = await this.deps.renderer.getPageTextEnsured(p); } catch { /* Skip an unreadable page, retain other hits. */ }
			if (token !== this.state.token) return;
			hasText ||= !!text.trim();
			const hits = findHits([text], query).map(hit => ({ ...hit, page: p }));
			this.state.hits.push(...hits);
			if (this.state.current < 0 && this.state.hits.length) await this.goto(1, true);
			if (token !== this.state.token) return;
			if (countEl) countEl.setText(`${this.state.current >= 0 ? this.state.current + 1 : 0} / ${this.state.hits.length} · ${p}/${n}`);
		}
		if (countEl) countEl.setText(this.state.hits.length ? `${this.state.current + 1} / ${this.state.hits.length}` : hasText ? t("无结果") : t("无法提取文本（可能是扫描件）"));
	}

	async goto(dir: number, absolute = false): Promise<void> {
		const total = this.state.hits.length;
		if (total === 0) return;
		this.state.current = absolute
			? 0
			: (((this.state.current + dir) % total) + total) % total;
		const hit = this.state.hits[this.state.current];
		this.deps.count()?.setText(`${this.state.current + 1} / ${total}`);
		const token = this.state.token;
		this.deps.rememberNavigation();
		await this.deps.scrollToPage(hit.page);
		if (token !== this.state.token) return;
		this.applyHighlights(hit);
		const page = this.deps.pages().find(p => p.pageNumber === hit.page);
		const range = page && this.deps.domRangeForText(page.wrapper, hit.index, hit.length);
		if (range && page) {
			const bounds = page.wrapper.getBoundingClientRect(), rect = range.getBoundingClientRect();
			this.deps.scrollToRect(hit.page, { x: (rect.left - bounds.left) / this.deps.scale(), y: (rect.top - bounds.top) / this.deps.scale(), width: rect.width / this.deps.scale(), height: rect.height / this.deps.scale() });
		}
	}

	/** map hit char offsets to DOM ranges and draw temporary highlight rects */
	applyHighlights(current: SearchHit): void {
		this.deps.clearHighlights();
		const page = this.deps.pages().find((p) => p.pageNumber === current.page);
		if (!page) return;
		const layer = page.highlightLayer;
		const hitsOnPage = this.state.hits.filter((h) => h.page === current.page);
		for (const hit of hitsOnPage) {
			const range = this.deps.domRangeForText(page.wrapper, hit.index, hit.length);
			if (!range) continue;
			const pageRect = page.wrapper.getBoundingClientRect();
			for (const r of mergeTextRects(textRangeRects(range, page.wrapper))) {
				if (r.width < 2 || r.height < 2) continue;
				const el = layer.createDiv({
					cls: hit === current ? "pr-search-hit pr-search-current" : "pr-search-hit",
				});
				el.style.left = `${r.left - pageRect.left}px`;
				el.style.top = `${r.top - pageRect.top}px`;
				el.style.width = `${r.width}px`;
				el.style.height = `${r.height}px`;
			}
		}
	}

}
