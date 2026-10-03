import { GlobalWorkerOptions, getDocument, OPS, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { preciseTextContent, preserveWordSelection, buildPageText, PageTextMapping } from "./preciseText";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import type {
	PDFDocumentLoadingTask,
	PDFDocumentProxy,
	PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { OutlineNode } from "../outline/OutlineTree";

type PdfOutlineItem = {
	title: string;
	dest: string | unknown[] | null;
	items: PdfOutlineItem[];
};

declare const __PDF_RESOURCES__: Record<string, string>;

/** BinaryDataFactory keeps CMaps, fonts and decoders inside the offline plugin bundle. */
export class BundledPdfResources {
	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const directory = { cMapUrl: "cmaps", standardFontDataUrl: "standard_fonts", wasmUrl: "wasm" }[kind];
		const encoded = typeof __PDF_RESOURCES__ === "undefined" ? undefined : __PDF_RESOURCES__[`${directory}/${filename}`];
		if (!encoded) throw new Error(`Missing bundled PDF resource: ${kind}/${filename}`);
		return Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
	}
}

export interface PdfLink { url?: string; dest?: string | unknown[]; page?: number; rect: number[] }
export interface PdfLoadOptions {
	ownerDocument?: Document;
	onPassword?: (updatePassword: (password: string) => void, reason: number) => void;
}

type PdfRef = { num: number; gen: number };

function isRefProxy(value: unknown): value is PdfRef {
	return typeof value === "object" && value !== null &&
		typeof (value as PdfRef).num === "number" &&
		typeof (value as PdfRef).gen === "number";
}

export interface RenderedPage {
	pageNumber: number;
	/** wrapper element (.pr-page), position: relative */
	wrapper: HTMLElement;
	/** absolutely positioned overlay holding highlight rects */
	highlightLayer: HTMLElement;
	/** transient overlay for the active text selection */
	selectionLayer: HTMLElement;
	/** absolutely positioned SVG holding pen strokes */
	inkLayer: SVGSVGElement;
	/** unscaled page size (viewport at scale 1) */
	widthAtScale1: number;
	heightAtScale1: number;
}

/** Point GlobalWorkerOptions at the worker bundle shipped next to main.js. */
export function configurePdfWorker(workerUrl: string): void {
	GlobalWorkerOptions.workerSrc = workerUrl;
}

export class PdfRenderer {
	private doc: PDFDocumentProxy | null = null;
	private loadingTask: PDFDocumentLoadingTask | null = null;
	/** joined extracted text per page, used for offset + context fingerprint */
	private pageTexts = new Map<number, string>();
	private pageTextMappings = new Map<number, PageTextMapping>();
	/** cached page proxies shared by main rendering and thumbnails */
	private pageCache = new Map<number, Promise<PDFPageProxy>>();
	private generation = 0;
	private details = new Map<RenderedPage, { page: PDFPageProxy; scale: number; outputScale: number;
		canvas?: HTMLCanvasElement; task?: ReturnType<PDFPageProxy["render"]>; region?: string; revision: number }>();

	get numPages(): number {
		return this.doc?.numPages ?? 0;
	}

	getPageTextMapping(pageNumber: number): PageTextMapping | undefined { return this.pageTextMappings.get(pageNumber); }

	getPageText(pageNumber: number): string | undefined {
		return this.pageTexts.get(pageNumber);
	}

	/** Extract and cache a page's text, even if the page was never rendered. */
	async getPageTextEnsured(pageNumber: number): Promise<string> {
		const generation = this.generation;
		const cached = this.pageTexts.get(pageNumber);
		if (cached !== undefined) return cached;
		const page = await this.getPage(pageNumber);
		const tc = await page.getTextContent();
		const mapping = buildPageText(tc.items);
		if (generation === this.generation) { this.pageTexts.set(pageNumber, mapping.text); this.pageTextMappings.set(pageNumber, mapping); }
		return mapping.text;
	}

	async load(data: ArrayBuffer, options: PdfLoadOptions = {}): Promise<void> {
		for (const page of this.details.keys()) this.releasePage(page);
		const previous = this.loadingTask;
		const generation = ++this.generation;
		this.loadingTask = null;
		this.doc = null;
		this.pageTexts.clear(); this.pageTextMappings.clear(); this.pageCache.clear();
		await previous?.destroy();
		if (generation !== this.generation) return;
		const task = getDocument({ data, ownerDocument: options.ownerDocument as HTMLDocument | undefined,
			BinaryDataFactory: BundledPdfResources, useWorkerFetch: false, cMapPacked: true });
		if (options.onPassword) task.onPassword = options.onPassword;
		this.loadingTask = task;
		const doc = await task.promise;
		if (generation === this.generation) this.doc = doc;
		else await task.destroy();
	}

	async destroy(): Promise<void> {
		for (const page of this.details.keys()) this.releasePage(page);
		this.generation++;
		const task = this.loadingTask;
		this.loadingTask = null;
		this.doc = null;
		this.pageTexts.clear(); this.pageTextMappings.clear();
		this.pageCache.clear();
		await task?.destroy();
	}

	private getPage(pageNumber: number): Promise<PDFPageProxy> {
		if (!this.doc) throw new Error("no document loaded");
		let p = this.pageCache.get(pageNumber);
		if (!p) {
			p = this.doc.getPage(pageNumber);
			this.pageCache.set(pageNumber, p);
		}
		return p;
	}

	/** Unscaled page dimensions (viewport at scale 1) without rendering. */
	async getPageDims(
		pageNumber: number
	): Promise<{ width: number; height: number }> {
		const page = await this.getPage(pageNumber);
		const v = page.getViewport({ scale: 1 });
		return { width: v.width, height: v.height };
	}

	/** PDF outline (bookmarks) resolved to 1-based page numbers; null if none. */
	async getOutline(): Promise<OutlineNode[] | null> {
		if (!this.doc) return null;
		const doc = this.doc;
		const raw = await doc.getOutline() as PdfOutlineItem[] | null;
		if (!raw || raw.length === 0) return null;

		const resolve = async (items: PdfOutlineItem[]): Promise<OutlineNode[]> => {
			const out: OutlineNode[] = [];
			for (const item of items) {
				let page: number | null = null;
				try {
					const dest =
						typeof item.dest === "string"
							? await doc.getDestination(item.dest)
							: item.dest;
					if (Array.isArray(dest) && isRefProxy(dest[0])) {
						page = (await doc.getPageIndex(dest[0])) + 1;
					}
				} catch {
					// unresolvable destination: keep page null
				}
				out.push({
					title: item.title || "(未命名)",
					page,
					children: await resolve(item.items ?? []),
				});
			}
			return out;
		};
		return resolve(raw);
	}

	async getPageLabels(): Promise<string[] | null> { return this.doc?.getPageLabels() ?? null; }

	async resolveDestination(destination: string | unknown[]): Promise<number | null> {
		if (!this.doc) return null;
		const dest = typeof destination === "string" ? await this.doc.getDestination(destination) : destination;
		if (!dest) return null;
		if (isRefProxy(dest[0])) return (await this.doc.getPageIndex(dest[0])) + 1;
		return Number.isInteger(dest[0]) ? (dest[0] as number) + 1 : null;
	}

	async getPageLinks(pageNumber: number): Promise<PdfLink[]> {
		const page = await this.getPage(pageNumber);
		const annotations = await page.getAnnotations({ intent: "display" });
		return annotations.filter(a => a.subtype === "Link" && (a.url || a.dest)).map(a => ({
			url: a.url, dest: a.dest, rect: a.rect,
		}));
	}

	/** Render a small canvas for the thumbnail sidebar. */
	async renderThumbnail(
		pageNumber: number,
		targetWidth: number,
		ownerDocument: Document = document
	): Promise<HTMLCanvasElement> {
		const page = await this.getPage(pageNumber);
		const base = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: targetWidth / base.width });
		const dpr = Math.max(ownerDocument.defaultView?.devicePixelRatio || 1, 1);
		const canvas = ownerDocument.createElement("canvas");
		canvas.width = Math.floor(viewport.width * dpr);
		canvas.height = Math.floor(viewport.height * dpr);
		canvas.style.width = `${Math.floor(viewport.width)}px`;
		canvas.style.height = `${Math.floor(viewport.height)}px`;
		await page.render({
			canvas,
			viewport,
			transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
		}).promise;
		return canvas;
	}

	/**
	 * Render one page into a fresh wrapper element:
	 * canvas (bottom) -> text layer (selection) -> highlight layer (top).
	 */
	async createPlaceholder(pageNumber: number, scale: number, ownerDocument: Document = document): Promise<RenderedPage> {
		const dims = await this.getPageDims(pageNumber);
		const wrapper = ownerDocument.createElement("div");
		wrapper.className = "pr-page";
		wrapper.dataset.pageNumber = String(pageNumber);
		wrapper.style.width = `${Math.floor(dims.width * scale)}px`;
		wrapper.style.height = `${Math.floor(dims.height * scale)}px`;
		// CSS vars expected by pdf.js v6 text layer styles
		wrapper.style.setProperty("--total-scale-factor", String(scale));
		wrapper.style.setProperty("--scale-round-x", "1px");
		wrapper.style.setProperty("--scale-round-y", "1px");
		return { pageNumber, wrapper, highlightLayer: ownerDocument.createElement("div"), selectionLayer: ownerDocument.createElement("div"), inkLayer: ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg"),
			widthAtScale1: dims.width, heightAtScale1: dims.height };
	}

	/** Move rendering state when a virtualized placeholder adopts the rendered children. */
	adoptPage(rendered: RenderedPage, target: RenderedPage): void {
		const state = this.details.get(rendered);
		if (!state || rendered === target) return;
		this.details.delete(rendered);
		this.details.set(target, state);
	}

	releasePage(page: RenderedPage): void {
		const detail = this.details.get(page);
		detail?.task?.cancel();
		this.details.delete(page);
		for (const canvas of Array.from(page.wrapper.querySelectorAll("canvas"))) canvas.width = canvas.height = 0;
		page.wrapper.replaceChildren();
		page.highlightLayer.replaceChildren(); page.selectionLayer.replaceChildren(); page.inkLayer.replaceChildren();
		void this.pageCache.get(page.pageNumber)?.then(proxy => proxy.cleanup()).catch(() => {});
	}

	async renderPage(pageNumber: number, scale: number, signal?: AbortSignal, ownerDocument: Document = document, onLink?: (link: PdfLink) => void, target?: RenderedPage): Promise<RenderedPage> {
		const generation = this.generation;
		const page = await this.getPage(pageNumber);
		// Paint directly into the reading window so text/link work cannot delay the raster.
		const shell = target ?? await this.createPlaceholder(pageNumber, scale, ownerDocument);
		const { wrapper } = shell;
		const viewport = page.getViewport({ scale });
		const check = () => {
			if (signal?.aborted || generation !== this.generation) throw new DOMException("Page render cancelled", "AbortError");
		};
		check();
		let renderTask: ReturnType<PDFPageProxy["render"]> | undefined;
		let textLayer: TextLayer | undefined;
		const cancel = () => { renderTask?.cancel(); textLayer?.cancel(); };
		signal?.addEventListener("abort", cancel, { once: true });
		try {

			const canvas = ownerDocument.createElement("canvas");
			canvas.className = "pr-canvas"; wrapper.appendChild(canvas);
			// Bound a single zoomed page to 8 MP; Unicode selection remains full resolution.
			const outputScale = Math.min(Math.max(ownerDocument.defaultView?.devicePixelRatio || 1, 1), Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
			canvas.width = Math.floor(viewport.width * outputScale);
			canvas.height = Math.floor(viewport.height * outputScale);
			canvas.style.width = `${Math.floor(viewport.width)}px`;
			canvas.style.height = `${Math.floor(viewport.height)}px`;
			renderTask = page.render({
				canvas,
				viewport,
				transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
			});
			await renderTask.promise;
			check();

			const textLayerEl = ownerDocument.createElement("div");
			textLayerEl.className = "textLayer"; wrapper.appendChild(textLayerEl);
			const [textContent, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
			check();
			const precise = preciseTextContent(textContent, operatorList, OPS);
			const mapping = buildPageText(precise.content.items);
			textLayer = new TextLayer({
				textContentSource: precise.content,
				container: textLayerEl,
				viewport,
			});
			await textLayer.render();
			check();
			// PDF.js fits whole runs but normally leaves one-character spans unscaled.
			// Fit each verified glyph cell too, so native mouse hit testing uses PDF widths.
			const measure = canvas.getContext("2d")!;
			measure.save();
			const groups = new Map<TextItem, HTMLElement[]>();
			let divIndex = 0;
			for (const item of precise.content.items) {
				if (!("str" in item)) continue;
				const offsets = mapping.items[divIndex];
				const div = textLayer.textDivs[divIndex++];
				if (div && offsets) { div.dataset.prTextStart = String(offsets.start); div.dataset.prTextEnd = String(offsets.end); }
				if (!precise.glyphItems.has(item) || !div) continue;
				const original = precise.glyphItems.get(item)!;
				const group = groups.get(original) ?? [];
				group.push(div); groups.set(original, group);
				const transform = item.transform as number[];
				const fontSize = Math.hypot(transform[2], transform[3]) * scale * outputScale;
				measure.font = `${fontSize}px ${div.style.fontFamily}`;
				const width = measure.measureText(item.str).width;
				if (width > 0) div.style.setProperty("--scale-x", String(item.width * scale * outputScale / width));
			}
			measure.restore();
			preserveWordSelection(textLayerEl, [...groups.values()]);

			// cache extracted text for selection fingerprinting
			this.pageTexts.set(pageNumber, mapping.text);
			this.pageTextMappings.set(pageNumber, mapping);

			const highlightLayer = ownerDocument.createElement("div");
			highlightLayer.className = "pr-highlight-layer"; wrapper.appendChild(highlightLayer);
			const selectionLayer = ownerDocument.createElement("div");
			selectionLayer.className = "pr-selection-layer"; wrapper.appendChild(selectionLayer);

			const inkLayer = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
			inkLayer.classList.add("pr-ink-layer");
			wrapper.appendChild(inkLayer);

			const links = await this.getPageLinks(pageNumber);
			check();
			for (const link of links) {
				let url: URL | undefined;
				try { if (link.url) url = new URL(link.url); } catch { continue; }
				if (url && !["https:", "http:", "mailto:"].includes(url.protocol)) continue;
				const [a, b, c, d, e, f] = viewport.transform;
				const [x, y, right, bottom] = link.rect;
				const [x1, y1, x2, y2] = [a*x+c*y+e, b*x+d*y+f, a*right+c*bottom+e, b*right+d*bottom+f];
				const anchor = ownerDocument.createElement("a");
				anchor.className = "pr-pdf-link";
				anchor.href = url?.href ?? "#";
				anchor.setAttribute("aria-label", link.url ?? "跳转到 PDF 页面");
				anchor.style.cssText = `position:absolute;z-index:5;left:${Math.min(x1,x2)}px;top:${Math.min(y1,y2)}px;width:${Math.abs(x2-x1)}px;height:${Math.abs(y2-y1)}px;`;
				if (url) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
				anchor.addEventListener("click", event => {
					if (!url) { event.preventDefault(); onLink?.(link); }
				});
				wrapper.appendChild(anchor);
			}
			const rendered = { ...shell, highlightLayer, selectionLayer, inkLayer };
			this.details.set(rendered, { page, scale, outputScale, revision: 0 });
			return rendered;
		} catch (error) {
			this.releasePage(shell);
			throw error;
		} finally { signal?.removeEventListener("abort", cancel); }
	}
	/** Supplement the bounded whole-page canvas with a DPR-resolution visible crop. */
	async updateDetail(rendered: RenderedPage, visible: DOMRect): Promise<void> {
		const state = this.details.get(rendered);
		if (!state) return;
		const dpr = Math.max(rendered.wrapper.ownerDocument.defaultView?.devicePixelRatio || 1, 1);
		if (state.outputScale >= dpr) return;
		const box = rendered.wrapper.getBoundingClientRect();
		const left = Math.max(0, visible.left - box.left), top = Math.max(0, visible.top - box.top);
		const width = Math.min(box.right, visible.right) - box.left - left;
		const height = Math.min(box.bottom, visible.bottom) - box.top - top;
		if (width <= 0 || height <= 0) {
			state.task?.cancel(); state.revision++; state.region = undefined;
			if (state.canvas) { state.canvas.remove(); state.canvas.width = state.canvas.height = 0; state.canvas = undefined; }
			return;
		}
		// ponytail: crop budget is 8 MP; very large displays still need tiled rendering.
		const outputScale = Math.min(dpr, Math.sqrt(8_000_000 / (width * height)));
		const region = [left, top, width, height, outputScale].join(":");
		if (state.region === region) return;
		state.task?.cancel();
		state.region = region;
		const revision = ++state.revision;
		const canvas = rendered.wrapper.ownerDocument.createElement("canvas");
		canvas.className = "pr-detail-canvas";
		canvas.width = Math.max(1, Math.ceil(width * outputScale));
		canvas.height = Math.max(1, Math.ceil(height * outputScale));
		canvas.style.cssText = `position:absolute;pointer-events:none;left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
		const task = state.page.render({ canvas, viewport: state.page.getViewport({ scale: state.scale }),
			transform: [outputScale, 0, 0, outputScale, -left * outputScale, -top * outputScale] });
		state.task = task;
		try {
			await task.promise;
			if (state.revision !== revision || this.details.get(rendered) !== state) return;
			if (state.canvas) { state.canvas.remove(); state.canvas.width = state.canvas.height = 0; }
			state.canvas = canvas;
			rendered.wrapper.insertBefore(canvas, rendered.wrapper.children[1] ?? null);
		} catch (error) {
			if ((error as Error).name !== "RenderingCancelledException") {
				state.region = undefined;
				throw error;
			}
		} finally {
			if (state.canvas !== canvas) canvas.width = canvas.height = 0;
			if (state.task === task) state.task = undefined;
		}
	}

}
