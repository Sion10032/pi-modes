import type { ToolInfo } from "@earendil-works/pi-coding-agent";

// 通用工具函数：被 plan-mode 与 readonly-mode 共用

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function stringField(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}

export function unique<T>(values: T[]) {
	return Array.from(new Set(values));
}

export function isBuiltinTool(tool: ToolInfo) {
	return tool.sourceInfo.source === "builtin";
}

export function compareTools(left: ToolInfo, right: ToolInfo) {
	const leftBuiltin = isBuiltinTool(left);
	const rightBuiltin = isBuiltinTool(right);
	if (leftBuiltin !== rightBuiltin) return leftBuiltin ? -1 : 1;
	return left.name.localeCompare(right.name);
}

export function toolSourceLabel(tool: ToolInfo) {
	const sourceInfo = tool.sourceInfo;
	const source = `${sourceInfo.scope}/${sourceInfo.source}`;
	return sourceInfo.path ? `${source} ${sourceInfo.path}` : source;
}

/** 从 bash 工具调用入参中读取命令字符串 */
export function readCommand(input: unknown) {
	const command = input as { command?: unknown } | undefined;
	return typeof command?.command === "string" ? command.command : "";
}

/** 在后台 microtask 中调度一个异步任务，并以指定前缀记录失败 */
export function scheduleAfterCurrentAgentRun(
	task: () => Promise<void> | void,
	logPrefix: string,
) {
	setTimeout(() => {
		void Promise.resolve(task()).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`${logPrefix}: ${message}`);
		});
	}, 0);
}
