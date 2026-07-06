import type { SessionMessage, TextBlock } from "./types.js";

// 会话消息读取与 <proposed_plan> 块的清理工具

const PROPOSED_PLAN_PATTERN =
	/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PROPOSED_PLAN_BLOCK_PATTERN =
	/<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/gi;

/** 提取 <proposed_plan> 中的正文 */
export function extractProposedPlan(text: string) {
	const match = PROPOSED_PLAN_PATTERN.exec(text);
	return match?.[1]?.trim();
}

/** 移除所有 <proposed_plan> 块 */
export function stripProposedPlanBlocks(text: string) {
	return text.replace(PROPOSED_PLAN_BLOCK_PATTERN, "");
}

/** 从单条消息中移除 <proposed_plan> 块（不可变） */
export function stripProposedPlanBlocksFromMessage<T>(message: T): T {
	const candidate = unwrapSessionMessage(message);
	if (candidate.role !== "assistant") return message;

	const content = stripProposedPlanBlocksFromContent(candidate.content);
	if (content === candidate.content) return message;

	if (isSessionMessageEntry(message)) {
		return { ...message, message: { ...candidate, content } };
	}
	return { ...candidate, content } as T;
}

/** 取最近一条 assistant 文本（多种载体形态都支持） */
export function latestAssistantText(messages: unknown) {
	if (!Array.isArray(messages)) return "";
	for (const entry of [...messages].reverse()) {
		const message =
			(entry as { message?: SessionMessage })?.message ??
			(entry as SessionMessage);
		if (message?.role !== "assistant") continue;
		const text = messageText(message);
		if (text) return text;
	}
	return "";
}

/** 解开会话载体，返回内部 message 对象 */
export function unwrapSessionMessage(message: unknown) {
	const entry = message as { message?: unknown };
	return (entry.message ?? message) as {
		role?: string;
		customType?: string;
		content?: unknown;
	};
}

function isSessionMessageEntry<T>(
	message: T,
): message is T & { message: SessionMessage } {
	return (
		typeof message === "object" && message !== null && "message" in message
	);
}

function stripProposedPlanBlocksFromContent(content: unknown) {
	if (typeof content === "string") return stripProposedPlanBlocks(content);
	if (!Array.isArray(content)) return content;

	let changed = false;
	const nextContent = content.map((block) => {
		const textBlock = block as TextBlock;
		if (textBlock.type !== "text" || typeof textBlock.text !== "string")
			return block;

		const text = stripProposedPlanBlocks(textBlock.text);
		if (text === textBlock.text) return block;

		changed = true;
		return { ...textBlock, text };
	});
	return changed ? nextContent : content;
}

function messageText(message: SessionMessage) {
	return contentText(message.content);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const textBlock = block as TextBlock;
			return textBlock.type === "text" && typeof textBlock.text === "string"
				? textBlock.text
				: "";
		})
		.filter(Boolean)
		.join("\n");
}
