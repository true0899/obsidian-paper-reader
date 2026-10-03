import type { Annotation } from "../storage/annotationStore";
import { cloneAnnotation, type HistoryOp } from "../history/AnnotationHistory";
import type { RenderedPage } from "./PdfRenderer";
import { beginInkRectangle, beginInkStroke, inkBoundingRect, rectanglePoints, transformRectangle,
	type LiveStroke, type RectangleBounds, type RectangleHandle } from "./InkLayer";

export type DrawingTool = "pen" | "rectangle" | null;
export interface RectangleEdit {
	id: string; page: number; pointerId: number; handle: RectangleHandle;
	startX: number; startY: number; bounds: RectangleBounds; before: Annotation;
}
export interface DrawingState {
	readonly tool: DrawingTool;
	liveStroke: LiveStroke | null;
	liveStrokePage: number;
	rectangleEdit: RectangleEdit | null;
}
interface DrawingDependencies {
	pages: () => RenderedPage[];
	scale: () => number;
	scrollElement: () => HTMLElement;
	annotations: () => Annotation[];
	setAnnotations: (annotations: Annotation[]) => void;
	color: () => { key: string; css: string };
	width: () => number;
	documentIdentity: () => number | null;
	persistAndRefresh: (pages: number[]) => Promise<boolean>;
	recordHistory: (operation: HistoryOp) => void;
	setTool: (tool: DrawingTool) => void;
	selectRectangle: (annotation: Annotation, x: number, y: number) => void;
	redrawInk: (page: RenderedPage) => void;
	redrawAllInk: () => void;
}

/** Pointer drawing and rectangle editing. View dependencies remain explicit;
 * this controller never owns a workspace view or a document lifecycle. */
export class DrawingController {
	constructor(private state: DrawingState, private deps: DrawingDependencies) {}
	pageFromEvent(e: PointerEvent): RenderedPage | null {
		const el = (e.target as HTMLElement).closest?.(".pr-page");
		if (!(el instanceof HTMLElement)) return null;
		const n = Number(el.dataset.pageNumber);
		return this.deps.pages().find((p) => p.pageNumber === n) ?? null;
	}

	pointerDown(e: PointerEvent): void {
		if (e.button !== 0 || this.state.liveStroke || this.state.rectangleEdit) return;
		const editTarget = (e.target as Element).closest?.<SVGElement>("[data-ink-handle]");
		if (!this.state.tool && editTarget?.dataset.annotationId && editTarget.dataset.inkHandle) {
			const ann = this.deps.annotations().find((a) => a.id === editTarget.dataset.annotationId);
			const page = ann && this.deps.pages().find((p) => p.pageNumber === ann.page);
			if (ann?.ink?.shape === "rectangle" && page) {
				const point = this.pointOnPage(e, page);
				this.state.rectangleEdit = {
					id: ann.id, page: ann.page, pointerId: e.pointerId,
					handle: editTarget.dataset.inkHandle as RectangleHandle,
					startX: point.x, startY: point.y,
					bounds: inkBoundingRect(ann.ink.points), before: cloneAnnotation(ann),
				};
				e.preventDefault();
				e.stopPropagation();
				this.deps.scrollElement().setPointerCapture(e.pointerId);
				return;
			}
		}
		if (!this.state.tool) return;
		const page = this.pageFromEvent(e);
		if (!page) return;
		e.preventDefault();
		e.stopPropagation();
		const { x, y } = this.pointOnPage(e, page);
		this.state.liveStrokePage = page.pageNumber;
		const begin = this.state.tool === "rectangle" ? beginInkRectangle : beginInkStroke;
		this.state.liveStroke = begin(
			page.inkLayer,
			this.deps.color().css,
			this.deps.width(),
			this.deps.scale(),
			x,
			y
		);
		this.deps.scrollElement().setPointerCapture(e.pointerId);
	}

	pointerMove(e: PointerEvent): void {
		if (this.state.rectangleEdit) {
			const edit = this.state.rectangleEdit;
			const ann = this.deps.annotations().find((a) => a.id === edit.id);
			const page = this.deps.pages().find((p) => p.pageNumber === edit.page);
			if (!ann?.ink || !page) return;
			e.preventDefault();
			const point = this.pointOnPage(e, page);
			const bounds = transformRectangle(
				edit.bounds, edit.handle, point.x - edit.startX, point.y - edit.startY,
				page.widthAtScale1, page.heightAtScale1, 8 / this.deps.scale()
			);
			ann.ink.points = rectanglePoints(bounds.x, bounds.y, bounds.width, bounds.height);
			ann.rects = [bounds];
			this.deps.redrawInk(page);
			return;
		}
		if (!this.state.liveStroke) return;
		const page = this.deps.pages().find((p) => p.pageNumber === this.state.liveStrokePage);
		if (!page) return;
		e.preventDefault();
		const { x, y } = this.pointOnPage(e, page);
		this.state.liveStroke.addPoint(x, y);
	}

	pointerEnd(e: PointerEvent, commit: boolean): void {
		if (this.state.rectangleEdit) {
			void this.finishRectangleEdit(e.pointerId, commit);
			return;
		}
		const stroke = this.state.liveStroke;
		if (!stroke) return;
		this.state.liveStroke = null;
		if (this.deps.scrollElement().hasPointerCapture(e.pointerId)) {
			this.deps.scrollElement().releasePointerCapture(e.pointerId);
		}
		if (!commit) {
			stroke.discard();
			return;
		}
		const ink = stroke.finish();
		if (!ink || this.deps.documentIdentity() === null) return;
		const page = this.state.liveStrokePage;
		const ann: Annotation = {
			id: crypto.randomUUID(),
			type: "ink",
			page,
			rects: [inkBoundingRect(ink.points)],
			text: "",
			color: this.deps.color().key,
			ink,
			createdAt: new Date().toISOString(),
			textOffset: -1,
			contextBefore: "",
			contextAfter: "",
		};
		const document = this.deps.documentIdentity();
		this.deps.annotations().push(ann);
		void this.deps.persistAndRefresh([page]).then((ok) => {
			if (document !== this.deps.documentIdentity()) return;
			if (ok) {
				this.deps.recordHistory({ kind: "add", ann });
				if (ink.shape === "rectangle") {
					this.deps.setTool(null);
					this.deps.selectRectangle(ann, e.clientX, e.clientY);
				}
			}
			else this.deps.setAnnotations(this.deps.annotations().filter((a) => a.id !== ann.id));
		});
	}

	pointOnPage(e: PointerEvent, page: RenderedPage): { x: number; y: number } {
		const rect = page.wrapper.getBoundingClientRect();
		return {
			x: Math.min(Math.max((e.clientX - rect.left) / this.deps.scale(), 0), page.widthAtScale1),
			y: Math.min(Math.max((e.clientY - rect.top) / this.deps.scale(), 0), page.heightAtScale1),
		};
	}

	cancelRectangleEdit(): void {
		const edit = this.state.rectangleEdit;
		if (!edit) return;
		const ann = this.deps.annotations().find((a) => a.id === edit.id);
		if (ann) Object.assign(ann, edit.before);
		if (this.deps.scrollElement()?.hasPointerCapture(edit.pointerId)) this.deps.scrollElement().releasePointerCapture(edit.pointerId);
		this.state.rectangleEdit = null;
		this.deps.redrawAllInk();
	}

	async finishRectangleEdit(pointerId: number, commit: boolean): Promise<void> {
		const edit = this.state.rectangleEdit;
		if (!edit) return;
		this.state.rectangleEdit = null;
		if (this.deps.scrollElement().hasPointerCapture(pointerId)) this.deps.scrollElement().releasePointerCapture(pointerId);
		const ann = this.deps.annotations().find((a) => a.id === edit.id);
		if (!ann) return;
		if (!commit) {
			Object.assign(ann, edit.before);
			this.deps.redrawAllInk();
			return;
		}
		if (JSON.stringify(ann.ink?.points) === JSON.stringify(edit.before.ink?.points)) return;
		const document = this.deps.documentIdentity();
		const saved = await this.deps.persistAndRefresh([edit.page]);
		if (document !== this.deps.documentIdentity()) return;
		if (!saved) {
			Object.assign(ann, edit.before);
			this.deps.redrawAllInk();
			return;
		}
		this.deps.recordHistory({ kind: "update", before: edit.before, after: cloneAnnotation(ann) });
	}

}
