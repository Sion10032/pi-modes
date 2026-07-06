import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
	BLOCKED_BUILTIN_TOOLS,
	MUTATING_BASH_PATTERNS,
	SAFE_BASH_PATTERNS,
	SAFE_BUILTIN_TOOLS,
} from "./constants.js";
import { isBuiltinTool } from "./utils.js";

// 受限模式下的工具/命令安全策略

/** 是否允许在受限模式下勾选该工具 */
export function canSelectToolInRestrictedMode(tool: ToolInfo) {
	if (isBuiltinTool(tool)) return SAFE_BUILTIN_TOOLS.has(tool.name);
	return true;
}

/** 是否为应当被拦截的内置变更性工具 */
export function isBlockedBuiltinToolName(pi: ExtensionAPI, toolName: string) {
	if (!BLOCKED_BUILTIN_TOOLS.has(toolName)) return false;
	const tool = toolByName(pi, toolName);
	return tool ? isBuiltinTool(tool) : true;
}

/** 该工具名称是否对应一个内置工具（用于判断是否应受 bash 安全检查约束） */
export function isBuiltinToolName(pi: ExtensionAPI, toolName: string) {
	const tool = toolByName(pi, toolName);
	return tool ? isBuiltinTool(tool) : toolName === "bash";
}

function toolByName(pi: ExtensionAPI, toolName: string) {
	try {
		return pi.getAllTools().find((candidate) => candidate.name === toolName);
	} catch {
		return undefined;
	}
}

/** 受限模式下检查 bash 命令是否安全（既不在变更列表中、又匹配只读模式） */
export function isSafeCommand(command: string) {
	const trimmed = command.trim();
	if (!trimmed) return false;
	// 按 &&、||、; 拆解命令，逐段检查
	const segments = splitCommand(trimmed);
	return segments.every((segment) => isSafeSegment(segment));
}

/** 拆解命令为多个子命令 */
function splitCommand(command: string): string[] {
	// 简单拆解：按 &&、||、; 分割（忽略引号内的分隔符）
	const segments: string[] = [];
	let current = "";
	let inSingleQuote = false;
	let inDoubleQuote = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const prevChar = i > 0 ? command[i - 1] : "";

		// 处理引号
		if (char === "'" && prevChar !== "\\" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += char;
			continue;
		}
		if (char === '"' && prevChar !== "\\" && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current += char;
			continue;
		}

		// 不在引号内时检查分隔符
		if (!inSingleQuote && !inDoubleQuote) {
			// 检查 && 和 ||
			if (char === "&" && command[i + 1] === "&") {
				if (current.trim()) segments.push(current.trim());
				current = "";
				i++; // 跳过第二个 &
				continue;
			}
			if (char === "|" && command[i + 1] === "|") {
				if (current.trim()) segments.push(current.trim());
				current = "";
				i++; // 跳过第二个 |
				continue;
			}
			// 检查 ;
			if (char === ";") {
				if (current.trim()) segments.push(current.trim());
				current = "";
				continue;
			}
		}

		current += char;
	}

	if (current.trim()) segments.push(current.trim());
	return segments;
}

/** 检查单个命令段是否安全 */
function isSafeSegment(segment: string): boolean {
	if (MUTATING_BASH_PATTERNS.some((pattern) => pattern.test(segment)))
		return false;
	return SAFE_BASH_PATTERNS.some((pattern) => pattern.test(segment));
}
