import { t } from "../i18n";
import { App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import { ChatMessage, LlmClient, LlmError } from "../llm/client";
import {
	buildAskSystem,
	buildExplainMessages,
	buildTranslateMessages,
} from "../llm/prompts";
import type { SelectionPayload } from "../pdfview/selection";

export type PanelMode = "translate" | "explain" | "ask";

const MODE_TITLES: Record<PanelMode, string> = {
	translate: t("翻译"),
	explain: t("AI 解释"),
	ask: t("AI 问答"),
};

export interface NotesInsertEntry {
	title: string;
	page: number;
	quote: string;
	content: string;
}

export interface AnswerPanelCallbacks {
	/** fired once per completed answer (used to record translation annotations) */
	onAnswered: (mode: PanelMode, payload: SelectionPayload, answer: string) => void;
	onInsertNotes: (entry: NotesInsertEntry) => Promise<void>;
}

/**
 * Right-side answer drawer: quote block, streaming markdown answers,
 * multi-turn follow-up input, and footer actions
 * (copy / insert into notes / regenerate / clear).
 */
export class AnswerPanel {
	readonly el: HTMLElement;
	private titleEl: HTMLElement;
	private bodyEl: HTMLElement;
	private inputEl: HTMLTextAreaElement;

	private mode: PanelMode = "translate";
	private payload: SelectionPayload | null = null;
	private contextText = "";
	private history: ChatMessage[] = [];
	private lastAnswer = "";
	private streaming = false;
	private generation = 0;
	private requestAbort: AbortController | null = null;
	private renderedComponents = new Map<HTMLElement, Component>();

	private releaseAnswers(): void {
		for (const child of this.renderedComponents?.values() ?? []) this.component.removeChild(child);
		this.renderedComponents?.clear();
	}

	constructor(
		private app: App,
		private component: Component,
		private llm: LlmClient,
		private getTargetLang: () => string,
		private getSourcePath: () => string,
		private callbacks: AnswerPanelCallbacks
	) {
		this.el = createDiv({ cls: "pr-panel pr-hidden" });

		const header = this.el.createDiv({ cls: "pr-panel-header" });
		this.titleEl = header.createSpan({ cls: "pr-panel-title" });
		const closeBtn = header.createEl("button", { cls: "clickable-icon" });
		setIcon(closeBtn, "x");
		closeBtn.setAttr("aria-label", t("关闭面板"));
		closeBtn.addEventListener("click", () => this.close());

		this.bodyEl = this.el.createDiv({ cls: "pr-panel-body" });

		const inputWrap = this.el.createDiv({ cls: "pr-panel-input" });
		this.inputEl = inputWrap.createEl("textarea", {
			cls: "pr-panel-textarea",
			attr: { placeholder: t("追问 / 提问…（Enter 发送，Shift+Enter 换行）"), rows: "2" },
		});
		const sendBtn = inputWrap.createEl("button", { cls: "clickable-icon" });
		setIcon(sendBtn, "send-horizontal");
		sendBtn.setAttr("aria-label", t("发送"));
		sendBtn.addEventListener("click", () => void this.sendFollowUp());
		this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.sendFollowUp();
			}
			e.stopPropagation();
		});

		const footer = this.el.createDiv({ cls: "pr-panel-footer" });
		const mkFooterBtn = (icon: string, tooltip: string, onClick: () => void) => {
			const btn = footer.createEl("button", { cls: "clickable-icon" });
			setIcon(btn, icon);
			btn.setAttr("aria-label", tooltip);
			btn.addEventListener("click", onClick);
		};
		mkFooterBtn("copy", t("复制回答"), () => void this.copyAnswer());
		mkFooterBtn("file-plus-2", t("插入标注笔记"), () => void this.insertNotes());
		mkFooterBtn("refresh-ccw", t("重新生成"), () => this.regenerate());
		mkFooterBtn("trash-2", t("清空对话"), () => this.clearConversation());
	}

	get isOpen(): boolean {
		return !this.el.hasClass("pr-hidden");
	}

	prepareContext(mode: PanelMode, payload: SelectionPayload): void {
		this.start(mode, payload, "");
		this.streaming = true;
		const live = this.bodyEl.createDiv({ cls: "pr-msg pr-msg-assistant" });
		this.showWaiting(live, t("正在读取论文上下文…"));
	}

	showContextError(): void {
		this.streaming = false;
		const live = this.bodyEl.querySelector(".pr-msg-assistant");
		if (live) {
			live.setText(t("无法读取 AI 上下文，请重试"));
			live.setAttr("aria-busy", "false");
			live.addClass("pr-msg-error");
		}
	}

	private showWaiting(live: HTMLElement, label: string): void {
		live.setAttr("aria-busy", "true");
		const waiting = live.createDiv({ cls: "pr-answer-waiting" });
		waiting.setAttr("role", "status");
		const dots = waiting.createSpan({ cls: "pr-answer-dots" });
		dots.setAttr("aria-hidden", "true");
		for (let i = 0; i < 3; i++) dots.createSpan();
		waiting.createSpan({ text: label });
		this.scrollToBottom();
	}

	openTranslate(payload: SelectionPayload, contextText: string): void {
		this.start("translate", payload, contextText);
		void this.run(buildTranslateMessages(payload.text, this.getTargetLang()));
	}

	openExplain(payload: SelectionPayload, contextText: string): void {
		this.start("explain", payload, contextText);
		void this.run(buildExplainMessages(payload.text, contextText));
	}

	openAsk(payload: SelectionPayload, contextText: string): void {
		this.start("ask", payload, contextText);
		this.history = [buildAskSystem(payload.text, contextText)];
		this.inputEl.focus();
	}

	close(): void {
		this.requestAbort?.abort();
		this.requestAbort = null;
		this.generation++;
		this.releaseAnswers();
		this.bodyEl.empty();
		this.streaming = false;
		this.el.addClass("pr-hidden");
		this.history = [];
		this.lastAnswer = "";
	}

	private start(mode: PanelMode, payload: SelectionPayload, contextText: string): void {
		this.requestAbort?.abort();
		this.requestAbort = null;
		this.generation++;
		this.releaseAnswers();
		this.streaming = false;
		this.mode = mode;
		this.payload = payload;
		this.contextText = contextText;
		this.history = [];
		this.lastAnswer = "";
		this.titleEl.setText(MODE_TITLES[mode]);
		this.bodyEl.empty();
		const quote = this.bodyEl.createDiv({ cls: "pr-panel-quote" });
		quote.createSpan({ cls: "pr-panel-quote-page", text: `p.${payload.page}` });
		quote.createDiv({ cls: "pr-panel-quote-text", text: payload.text });
		if (contextText) {
			const pages = [...contextText.matchAll(/^\[page (\d+)\]/gm)].map(match => match[1]);
			let label = pages.length ? t("上下文：第 {pages} 页", { pages: pages.join(", ") }) : t("上下文：仅选中文本");
			if (contextText.includes("[context truncated:")) label += t("（达到长度上限，部分内容未提供）");
			quote.createDiv({ cls: "pr-panel-context" }).setText(label);
		}
		this.el.removeClass("pr-hidden");
	}

	// ---- conversation ----

	private async sendFollowUp(): Promise<void> {
		const question = this.inputEl.value.trim();
		if (!question || this.streaming || !this.payload) return;
		if (this.history.length === 0) {
			// no initial request yet (ask mode): start with system + question
			this.history = [buildAskSystem(this.payload.text, this.contextText)];
		}
		this.inputEl.value = "";
		const bubble = this.bodyEl.createDiv({ cls: "pr-msg pr-msg-user" });
		bubble.setText(question);
		this.scrollToBottom();
		const messages = [...this.history, { role: "user", content: question } as ChatMessage];
		await this.run(messages);
	}

	private async run(messages: ChatMessage[]): Promise<void> {
		if (this.streaming) return;
		this.streaming = true;
		const generation = this.generation;
		const requestAbort = new AbortController();
		this.requestAbort = requestAbort;
		const payload = this.payload;
		const mode = this.mode;
		this.history = messages;
		const live = this.bodyEl.createDiv({ cls: "pr-msg pr-msg-assistant pr-streaming" });
		this.showWaiting(live, t("正在生成回答…"));
		let answer = "";
		let renderedAnswer = "";
		let lastRenderAt = 0;
		let renderedComponent: Component | null = null;
		const sourcePath = this.getSourcePath();
		const render = async () => {
			const snapshot = answer;
			const target = createDiv();
			const renderComponent = this.component.addChild(new Component());
			try {
				await MarkdownRenderer.render(this.app, snapshot, target, sourcePath, renderComponent);
			} catch { target.setText(snapshot); }
			if (generation !== this.generation) {
				this.component.removeChild(renderComponent);
				return;
			}
			if (renderedComponent) this.component.removeChild(renderedComponent);
			renderedComponent = renderComponent;
			(this.renderedComponents ??= new Map()).set(live, renderComponent);
			live.replaceChildren(target);
			renderedAnswer = snapshot;
			lastRenderAt = Date.now();
			this.scrollToBottom();
		};
		try {
			for await (const chunk of this.llm.streamChat(messages, requestAbort.signal)) {
				if (generation !== this.generation) return;
				answer += chunk;
				if (!renderedAnswer || Date.now() - lastRenderAt >= 100) await render();
			}
		} catch (e) {
			if (generation !== this.generation) return;
			const msg =
				e instanceof LlmError ? e.message : t("请求出错：{error}", { error: (e as Error).message });
			live.setText(msg);
			live.addClass("pr-msg-error");
			live.removeClass("pr-streaming");
			live.setAttr("aria-busy", "false");
			new Notice(msg);
			this.streaming = false;
			return;
		}
		if (generation !== this.generation) return;
		if (renderedAnswer !== answer) await render();
		if (generation !== this.generation) return;
		this.streaming = false;
		this.history = [...messages, { role: "assistant", content: answer }];
		this.lastAnswer = answer;
		live.removeClass("pr-streaming");
		live.setAttr("aria-busy", "false");
		if (!answer) live.empty();
		if (answer) {
			const actions = live.createDiv({ cls: "pr-msg-actions" });
			const copy = actions.createEl("button", {
				cls: "pr-msg-copy",
				attr: { type: "button", "aria-label": t("复制回答") },
			});
			setIcon(copy.createSpan(), "copy");
			copy.createSpan({ text: t("复制回答") });
			copy.addEventListener("click", () => void this.copyAnswer(answer));
			this.scrollToBottom();
		}

		if (generation === this.generation && payload) {
			this.callbacks.onAnswered(mode, payload, answer);
		}
	}

	private regenerate(): void {
		if (this.streaming || this.history.length === 0) return;
		let messages = this.history;
		if (messages[messages.length - 1].role === "assistant") {
			messages = messages.slice(0, -1);
			const bubbles = this.bodyEl.querySelectorAll(".pr-msg-assistant");
			const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
			if (last) {
				const child = this.renderedComponents?.get(last);
				if (child) this.component.removeChild(child);
				this.renderedComponents?.delete(last);
				last.remove();
			}
		}
		void this.run(messages);
	}

	private clearConversation(): void {
		if (this.streaming) return;
		this.releaseAnswers();
		this.bodyEl.querySelectorAll(".pr-msg").forEach((el) => el.remove());
		if (this.mode === "ask") {
			this.history = this.payload
				? [buildAskSystem(this.payload.text, this.contextText)]
				: [];
		} else {
			this.history = [];
		}
		this.lastAnswer = "";
	}

	private async copyAnswer(answer = this.lastAnswer): Promise<void> {
		if (!answer) {
			new Notice(t("暂无回答可复制"));
			return;
		}
		try {
			await navigator.clipboard.writeText(answer);
			new Notice(t("已复制回答"));
		} catch {
			new Notice(t("复制失败"));
		}
	}

	private async insertNotes(): Promise<void> {
		if (!this.payload || !this.lastAnswer) {
			new Notice(t("暂无回答可插入"));
			return;
		}
		await this.callbacks.onInsertNotes({
			title: MODE_TITLES[this.mode],
			page: this.payload.page,
			quote: this.payload.text,
			content: this.lastAnswer,
		});
	}

	private scrollToBottom(): void {
		this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
	}
}
