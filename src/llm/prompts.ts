import type { ChatMessage } from "./client";

/** System+user messages for academic translation. */
export function buildTranslateMessages(
	text: string,
	targetLang: string
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				`你是学术论文翻译助手。把用户给出的内容翻译成${targetLang}。` +
				"要求：专业术语准确；公式、变量与 LaTeX 代码保持原样不翻译；只输出译文，不要加任何解释或前后缀。",
		},
		{ role: "user", content: text },
	];
}

/** System+user messages for explaining a selection with context. */
export function buildExplainMessages(
	selection: string,
	context: string
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"你是学术论文阅读助手。用中文解释用户选中的内容，只回答理解该内容所必需的信息。" +
				"解释时，使用 80% 的 ASD-STE100 风格回答：优先使用短句、常用词和直接表达，保留必要的专业术语。" +
				"回答保持简洁：除非用户明确要求详细解释，否则默认 100～150 字，最多 200 字。先用一句话说明核心含义，必要时补充最多 2 个短要点。" +
				"不要添加章节标题、开场白或结尾总结；不要重复结论、逐一解释无关术语，或展开整篇论文的方法。" +
				"除非选中内容本身是公式，或用户明确要求，否则不要添加公式、参数量或额外例子。解释公式时只说明必要的符号和作用，不做额外推导。" +
				"结合提供的上下文作答，不要复述原文。没有上下文依据的信息不要补写；必要的推断须明确标明。回答使用 Markdown 排版。行内公式使用 $...$，独立公式使用 $$...$$。",
		},
		{
			role: "user",
			content: `【选中内容】\n${selection}\n\n【上下文】\n${context}`,
		},
	];
}

/** System message carrying the selection + context for free-form QA. */
export function buildAskSystem(selection: string, context: string): ChatMessage {
	return {
		role: "system",
		content:
			"你是学术论文问答助手。用户正在精读一篇论文并选中了部分内容，" +
			"请基于选中内容与上下文用中文回答用户的问题，回答使用 Markdown 排版。行内公式使用 $...$，独立公式使用 $$...$$。\n\n" +
			`【选中内容】\n${selection}\n\n【上下文】\n${context}`,
	};
}
