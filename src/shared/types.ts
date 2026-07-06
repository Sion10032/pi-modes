// 共享类型定义：被 plan-mode 与 readonly-mode 复用

export interface CommandArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export type SessionMessage = {
	role?: string;
	content?: unknown;
};

export type SessionEntry = {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: SessionMessage;
};

export type TextBlock = {
	type?: string;
	text?: string;
};
