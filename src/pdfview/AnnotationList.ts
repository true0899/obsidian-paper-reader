import { t } from "../i18n";
import { setIcon } from "obsidian";
import type { Annotation } from "../storage/annotationStore";
import { inkBoundingRect } from "./InkLayer";
import { COLOR_KEYS } from "../settings";
import { COLOR_LABELS } from "../toolbar/SelectionActions";

export interface AnnotationListCallbacks {
	onSelect: (ann: Annotation) => void;
	onExport: (ann: Annotation) => void;
	onExportAll: () => void;
}

export interface AnnotationFilter {
	query: string;
	/** empty = all colors */
	colors: Set<string>;
	/** empty = all types */
	type: string;
}

const TYPE_LABELS: Record<string, string> = {
	highlight: t("高亮"),
	note: t("批注"),
	translation: t("翻译"),
	qa: t("AI 问答"),
	ink: t("画笔"),
};

const TYPE_ICONS: Record<string, string> = {
	highlight: "highlighter",
	note: "message-square",
	translation: "languages",
	qa: "help-circle",
	ink: "pencil",
};

function excerpt(text: string, max = 60): string {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length > max ? t.slice(0, max) + "…" : t;
}

/** small SVG preview of an ink stroke for list/notes */
export function inkPreviewSvg(ann: Annotation, size = 48): SVGSVGElement | null {
	if (!ann.ink || !Array.isArray(ann.ink.points) || ann.ink.points.length < 2 || ann.ink.points.length % 2 !== 0 ||
		!ann.ink.points.every(Number.isFinite) || !Number.isFinite(ann.ink.width) || ann.ink.width <= 0) return null;
	const b = inkBoundingRect(ann.ink.points);
	const pad = ann.ink.width + 2;
	const w = Math.max(b.width + pad * 2, 1);
	const h = Math.max(b.height + pad * 2, 1);
	let d = `M ${ann.ink.points[0] - b.x + pad} ${ann.ink.points[1] - b.y + pad}`;
	for (let i = 2; i + 1 < ann.ink.points.length; i += 2) {
		d += ` L ${ann.ink.points[i] - b.x + pad} ${ann.ink.points[i + 1] - b.y + pad}`;
	}
	const svg = createSvg("svg", { attr: {
		xmlns: "http://www.w3.org/2000/svg", width: size, height: size,
		viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "xMidYMid meet",
	} });
	svg.createSvg("path", { attr: {
		d, fill: "none", stroke: "#888", "stroke-width": ann.ink.width,
		"stroke-linecap": "round", "stroke-linejoin": "round",
	} });
	return svg;
}

/**
 * Sidebar "annotations" mode: page-ordered list of all annotations with
 * jump + export actions. Rebuilt by the view after every data change.
 */
export class AnnotationList {
	readonly el: HTMLElement;

	private items: { el: HTMLElement; ann: Annotation }[] = [];
	private countEl: HTMLElement | null = null;
	private emptyEl: HTMLElement | null = null;

	constructor(
		private callbacks: AnnotationListCallbacks,
		private getColors: () => Record<string, string>,
		private filter: AnnotationFilter = { query: "", colors: new Set(), type: "" }
	) {
		this.el = createDiv({ cls: "pr-ann-list" });
	}

	private matches(ann: Annotation): boolean {
		const { query, colors, type } = this.filter;
		if (colors.size && !colors.has(ann.color)) return false;
		if (type && ann.type !== type) return false;
		if (!query) return true;
		const haystack = [ann.text, ann.note, ann.aiContent].filter(Boolean).join(" ").toLowerCase();
		return haystack.includes(query.toLowerCase());
	}

	/** Show or hide rows in place so typing in the search box keeps focus. */
	private applyFilter(): void {
		let shown = 0;
		for (const { el, ann } of this.items) {
			const visible = this.matches(ann);
			el.toggleClass("pr-hidden", !visible);
			if (visible) shown++;
		}
		const filtered = shown !== this.items.length;
		this.countEl?.setText(filtered ? `${shown} / ${this.items.length}` : String(this.items.length));
		this.emptyEl?.toggleClass("pr-hidden", shown > 0 || this.items.length === 0);
	}

	private buildFilters(annotations: Annotation[]): void {
		const bar = this.el.createDiv({ cls: "pr-ann-filters" });
		const search = bar.createEl("input", { cls: "pr-ann-search", attr: { type: "search", placeholder: t("搜索标注…"), "aria-label": t("搜索标注") } });
		search.value = this.filter.query;
		search.addEventListener("input", () => { this.filter.query = search.value.trim(); this.applyFilter(); });
		search.addEventListener("keydown", e => e.stopPropagation());

		const row = bar.createDiv({ cls: "pr-ann-filter-row" });
		const colors = this.getColors();
		const usedColors = COLOR_KEYS.filter(key => annotations.some(a => a.color === key && a.type !== "ink"));
		for (const key of usedColors) {
			const chip = row.createEl("button", { cls: "pr-ann-color-chip", attr: { type: "button", "aria-label": t("只看{color}", { color: COLOR_LABELS[key] ?? key }) } });
			chip.style.setProperty("--pr-chip-color", colors[key] ?? key);
			const sync = () => { chip.toggleClass("is-active", this.filter.colors.has(key)); chip.setAttr("aria-pressed", String(this.filter.colors.has(key))); };
			sync();
			chip.addEventListener("click", () => {
				if (this.filter.colors.has(key)) this.filter.colors.delete(key); else this.filter.colors.add(key);
				sync(); this.applyFilter();
			});
		}
		const types = Object.keys(TYPE_LABELS).filter(type => annotations.some(a => a.type === type));
		if (types.length > 1) {
			const select = row.createEl("select", { cls: "pr-ann-type dropdown", attr: { "aria-label": t("标注类型") } });
			select.createEl("option", { text: t("全部类型"), attr: { value: "" } });
			for (const type of types) select.createEl("option", { text: TYPE_LABELS[type], attr: { value: type } });
			if (!types.includes(this.filter.type)) this.filter.type = "";
			select.value = this.filter.type;
			select.addEventListener("change", () => { this.filter.type = select.value; this.applyFilter(); });
		} else {
			this.filter.type = "";
		}
	}

	build(annotations: Annotation[]): void {
		this.el.empty();
		const sorted = [...annotations].sort((a, b) => {
			if (a.page !== b.page) return a.page - b.page;
			const ra = a.rects[0];
			const rb = b.rects[0];
			return (ra?.y ?? 0) - (rb?.y ?? 0) || (ra?.x ?? 0) - (rb?.x ?? 0);
		});

		const header = this.el.createDiv({ cls: "pr-ann-header" });
		const title = header.createSpan({ cls: "pr-ann-title", text: t("标注") });
		this.countEl = title.createSpan({ cls: "pr-ann-count", text: String(sorted.length) });
		const exportAll = header.createEl("button", { cls: "clickable-icon" });
		setIcon(exportAll, "file-output");
		exportAll.setAttr("aria-label", t("全部导出到标注笔记"));
		exportAll.addEventListener("click", () => this.callbacks.onExportAll());

		this.items = [];
		if (sorted.length === 0) {
			this.el.createDiv({ cls: "pr-ann-empty", text: t("暂无标注") });
			return;
		}
		this.buildFilters(sorted);
		this.emptyEl = this.el.createDiv({ cls: "pr-ann-empty pr-hidden", text: t("没有匹配的标注") });

		const colors = this.getColors();
		for (const ann of sorted) {
			const item = this.el.createDiv({ cls: "pr-ann-item" });
			item.dataset.annotationId = ann.id;
			this.items.push({ el: item, ann });
			item.style.setProperty("--pr-ann-color", ann.type === "ink" ? "var(--text-faint)" : colors[ann.color] ?? "var(--text-faint)");
			item.addEventListener("click", () => this.callbacks.onSelect(ann));

			const iconEl = item.createSpan({ cls: "pr-ann-icon" });
			setIcon(iconEl, TYPE_ICONS[ann.type] ?? "highlighter");
			if (ann.type !== "ink") {
				iconEl.style.color = colors[ann.color] ?? "var(--text-muted)";
			}

			const main = item.createDiv({ cls: "pr-ann-main" });
			const firstLine = main.createDiv({ cls: "pr-ann-text" });
			if (ann.type === "ink") {
				const preview = main.createDiv({ cls: "pr-ann-ink-preview" });
				const svg = inkPreviewSvg(ann);
				if (svg) preview.appendChild(svg);
				firstLine.setText(t("画笔"));
			} else {
				firstLine.setText(excerpt(ann.text) || t("(无文本)"));
			}
			const detail =
				ann.type === "note" && ann.note
					? ann.note
					: ann.type === "translation" && ann.aiContent
						? ann.aiContent
						: "";
			if (detail) {
				main.createDiv({ cls: "pr-ann-detail", text: excerpt(detail, 48) });
			}

			const pageEl = item.createSpan({ cls: "pr-ann-page" });
			pageEl.setText(`p.${ann.page}`);

			const exportBtn = item.createEl("button", { cls: "pr-ann-export clickable-icon" });
			setIcon(exportBtn, "file-output");
			exportBtn.setAttr("aria-label", t("导出到标注笔记"));
			exportBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.callbacks.onExport(ann);
			});
		}
		this.applyFilter();
	}
}
