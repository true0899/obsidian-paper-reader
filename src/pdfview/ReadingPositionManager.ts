import type { ReadingPosition } from "../settings";

export interface PageGeometry {
	pageNumber: number;
	wrapper: Pick<HTMLElement, "offsetTop" | "offsetHeight">;
}

/** Reading-position geometry is independent of rendering and annotation state. */
export class ReadingPositionManager {
	static capture(pages: readonly PageGeometry[], scrollTop: number, viewportHeight: number,
		view: Pick<ReadingPosition, "zoomMode" | "scale" | "layoutMode">): ReadingPosition | null {
		if (!pages.length) return null;
		const mid = scrollTop + viewportHeight / 2;
		let page = pages[0];
		for (const candidate of pages) {
			if (candidate.wrapper.offsetTop > mid) break;
			page = candidate;
		}
		return { ...view, page: page.pageNumber,
			pageFraction: Math.min(Math.max((mid - page.wrapper.offsetTop) / (page.wrapper.offsetHeight || 1), 0), 1),
			updatedAt: Date.now() };
	}

	static normalize(saved: ReadingPosition, pageCount: number): ReadingPosition {
		return { ...saved,
			page: Math.min(Math.max(1, Number.isFinite(saved.page) ? Math.round(saved.page) : 1), Math.max(pageCount, 1)),
			pageFraction: Number.isFinite(saved.pageFraction) ? Math.min(Math.max(saved.pageFraction, 0), 1) : 0,
			zoomMode: ["manual", "fit-width", "fit-height"].includes(saved.zoomMode) ? saved.zoomMode : "fit-width",
			layoutMode: ["continuous", "single", "double-odd", "double-even"].includes(saved.layoutMode) ? saved.layoutMode : "continuous",
			scale: Number.isFinite(saved.scale) && saved.scale > 0 ? saved.scale : 1 };
	}

	static scrollTop(page: PageGeometry, fraction: number, viewportHeight: number): number {
		return Math.max(0, page.wrapper.offsetTop + fraction * page.wrapper.offsetHeight - viewportHeight / 2);
	}
}
