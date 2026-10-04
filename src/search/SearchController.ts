import { t } from "../i18n";
import { findPageHits, normalizeQuery, normalizeWithMap, type SearchHit } from "./searchText";
import { pageSearchGeometry } from "./searchGeometry";
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
	private indexedPages = new Map<number, { text: string; index: ReturnType<typeof normalizeWithMap> }>();
	private geometry = new WeakMap<HTMLElement, { token: number; textLayer: Element | null; scale: number; hits: Map<SearchHit, HighlightRect[]> }>();
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
		for (const page of this.indexedPages.keys()) if (page > n) this.indexedPages.delete(page);
		const normalizedQuery = normalizeQuery(query);
		let checkpoint = performance.now();
		let hasText = false;
		for (let p = 1; p <= n; p++) {
			if (token !== this.state.token) return;
			let text = "";
			try { text = await this.deps.renderer.getPageTextEnsured(p); } catch { /* Skip an unreadable page, retain other hits. */ }
			if (token !== this.state.token) return;
			hasText ||= !!text.trim();
			let cached = this.indexedPages.get(p);
			if (!cached || cached.text !== text) {
				cached = { text, index: normalizeWithMap(text) };
				this.indexedPages.set(p, cached);
			}
			const hits = findPageHits(cached.index, normalizedQuery, p);
			for (const hit of hits) this.state.hits.push(hit);
			if (this.state.current < 0 && this.state.hits.length) await this.goto(1, true);
			if (token !== this.state.token) return;
			if (countEl) countEl.setText(`${this.state.current >= 0 ? this.state.current + 1 : 0} / ${this.state.hits.length} · ${p}/${n}`);
			if (performance.now() - checkpoint >= 4) {
				await new Promise<void>(resolve => setTimeout(resolve, 0));
				if (token !== this.state.token) return;
				checkpoint = performance.now();
			}
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
		const textLayer = page.wrapper.querySelector(".textLayer"), scale = this.deps.scale();
		let cached = this.geometry.get(page.wrapper);
		if (!cached || cached.token !== this.state.token || cached.textLayer !== textLayer || cached.scale !== scale) {
			const rectsForHit = pageSearchGeometry(page.wrapper);
			cached = { token: this.state.token, textLayer, scale, hits: new Map() };
			for (const hit of hitsOnPage) cached.hits.set(hit, rectsForHit(hit.index, hit.length));
			this.geometry.set(page.wrapper, cached);
		}
		const fragment = page.wrapper.ownerDocument.createDocumentFragment();
		for (const hit of hitsOnPage) {
			for (const r of cached.hits.get(hit) ?? []) {
				const el = page.wrapper.ownerDocument.createElement("div");
				el.className = hit === current ? "pr-search-hit pr-search-current" : "pr-search-hit";
				el.style.left = `${r.x}px`;
				el.style.top = `${r.y}px`;
				el.style.width = `${r.width}px`;
				el.style.height = `${r.height}px`;
				fragment.appendChild(el);
			}
		}
		layer.appendChild(fragment);
	}

}
