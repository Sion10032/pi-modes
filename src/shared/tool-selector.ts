import type {
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_TOOLS,
	SAFE_BUILTIN_TOOLS,
	TOOL_SELECTOR_PAGE_SIZE,
} from "./constants.js";
import { canSelectToolInRestrictedMode } from "./tool-safety.js";
import {
	compareTools,
	isBuiltinTool,
	toolSourceLabel,
	unique,
} from "./utils.js";

// 受限模式下的工具选择器：分页交互、默认/可选集合计算

/** 受限模式下工具选择器的策略 */
export interface ToolSelectorPolicy {
	/** 模式名称（如「规划」「只读」），用于面向用户的提示 */
	modeName: string;
	/** 始终需要保留的工具名称（例如 plan_mode_question） */
	requiredToolName?: string;
	/** 在没有持久化配置时使用的默认工具集合，缺省为 SAFE_BUILTIN_TOOLS 中可用的内置项 */
	defaultToolNames?: (tools: ToolInfo[]) => string[];
}

/** 获取所有可被选择的工具，按内置优先 + 名称排序 */
export function selectableTools(
	pi: ExtensionAPI,
	policy: ToolSelectorPolicy,
): ToolInfo[] {
	let allTools: ToolInfo[];
	try {
		allTools = pi.getAllTools();
	} catch {
		allTools = [];
	}
	return allTools
		.filter((tool) => tool.name !== policy.requiredToolName)
		.sort(compareTools);
}

/** 获取受限模式下默认勾选的工具名称（未持久化时的兜底） */
export function defaultSelectedToolNames(tools: ToolInfo[]): string[] {
	return tools
		.filter((tool) => isBuiltinTool(tool) && SAFE_BUILTIN_TOOLS.has(tool.name))
		.map((tool) => tool.name);
}

/** 过滤掉当前不可选择/不存在的工具名称 */
export function filterAvailableSelectedNames(
	names: string[],
	tools: ToolInfo[],
) {
	const availableNames = new Set(
		tools.filter(canSelectToolInRestrictedMode).map((tool) => tool.name),
	);
	return unique(names.filter((name) => availableNames.has(name)));
}

/** 计算工具选择器的总页数 */
export function toolSelectorPageCount(tools: ToolInfo[]) {
	return Math.max(1, Math.ceil(tools.length / TOOL_SELECTOR_PAGE_SIZE));
}

/** 把工具名补齐为受限模式实际下发给会话的最终列表（去重 + 附加必需工具） */
export function buildActiveToolNames(
	toolNames: string[],
	policy: ToolSelectorPolicy,
) {
	const withoutRequired = stripRequiredTool(toolNames, policy);
	if (!policy.requiredToolName) return unique(withoutRequired);
	return unique([...withoutRequired, policy.requiredToolName]);
}

/** 从一组工具名中移除该模式的必需工具 */
export function stripRequiredTool(
	toolNames: string[],
	policy: ToolSelectorPolicy,
) {
	if (!policy.requiredToolName) return [...toolNames];
	return toolNames.filter((name) => name !== policy.requiredToolName);
}

/** 把单个工具格式化为多选项条目 */
export function formatToolChoice(
	tool: ToolInfo,
	selected: boolean,
	index: number,
) {
	const marker = selected ? "[x]" : "[ ]";
	return `${marker} ${index + 1}. ${tool.name} (${toolPolicyLabel(tool)})`;
}

function toolPolicyLabel(tool: ToolInfo) {
	if (isBuiltinTool(tool)) {
		if (!SAFE_BUILTIN_TOOLS.has(tool.name)) return "built-in blocked";
		return tool.name === "bash" ? "built-in limited" : "built-in";
	}
	return `user risk: ${toolSourceLabel(tool)}`;
}

/** 摘要式描述当前选中的工具列表 */
export function formatToolSummary(activeToolNames: string[]) {
	return `Tools: ${activeToolNames.length > 0 ? activeToolNames.join(", ") : "none"}`;
}

/** 解析持久化字段中携带的兼容旧版本格式的工具名称（旧版本可能使用 name\u001fpath 形式作为 key） */
export function toolNameFromLegacyKey(key: string, tools: ToolInfo[]) {
	const directName = tools.find((tool) => tool.name === key)?.name;
	if (directName) return directName;
	const [name] = key.split("\u001f");
	return tools.find((tool) => tool.name === name) ? name : undefined;
}

/** 恢复工具栏：受限模式退出时把工具集合恢复为模式开启前的快照 */
export function restoreTools(
	pi: ExtensionAPI,
	previousTools: string[] | undefined,
	policy: ToolSelectorPolicy,
) {
	const restoredTools =
		previousTools && previousTools.length > 0 ? previousTools : DEFAULT_TOOLS;
	pi.setActiveTools(stripRequiredTool(restoredTools, policy));
}

/** 当受限模式未启用时，去掉残留在工具栏上的必需工具（例如 plan_mode_question） */
export function deactivateRequiredTool(
	pi: ExtensionAPI,
	policy: ToolSelectorPolicy,
) {
	if (!policy.requiredToolName) return;
	let activeTools: string[];
	try {
		activeTools = pi.getActiveTools();
	} catch {
		activeTools = DEFAULT_TOOLS;
	}
	const filteredTools = stripRequiredTool(activeTools, policy);
	if (filteredTools.length !== activeTools.length) {
		pi.setActiveTools(filteredTools);
	}
}

/** 选中工具状态读取/写入接口，让 plan-mode 与 readonly-mode 各自管理自己的状态对象 */
export interface SelectedToolNamesAccessor {
	/** 读取已持久化的工具名集合；undefined 表示尚未配置（用默认值） */
	get(): string[] | undefined;
	/** 写入工具名集合 */
	set(names: string[]): void;
}

/**
 * 计算并归一化当前实际生效的工具名 Set。若 accessor 中存在过期/无效项会被自动清洗后写回。
 */
export function resolveSelectedToolNames(
	tools: ToolInfo[],
	accessor: SelectedToolNamesAccessor,
	policy: ToolSelectorPolicy,
) {
	const stored = accessor.get();
	if (stored === undefined) {
		const computeDefault = policy.defaultToolNames ?? defaultSelectedToolNames;
		return new Set(computeDefault(tools));
	}
	const filtered = filterAvailableSelectedNames(stored, tools);
	accessor.set(filtered);
	return new Set(filtered);
}

/** 计算受限模式下应当激活的工具名列表（含必需工具） */
export function computeActiveToolNames(
	pi: ExtensionAPI,
	accessor: SelectedToolNamesAccessor,
	policy: ToolSelectorPolicy,
) {
	const tools = selectableTools(pi, policy);
	if (tools.length === 0) {
		const fallback = ["read", "bash"];
		return buildActiveToolNames(fallback, policy);
	}
	const selectedNames = resolveSelectedToolNames(tools, accessor, policy);
	const allowed = tools
		.filter(
			(tool) =>
				selectedNames.has(tool.name) && canSelectToolInRestrictedMode(tool),
		)
		.map((tool) => tool.name);
	return buildActiveToolNames(allowed, policy);
}

/** 工具选择器交互回调集合 */
export interface ToolSelectorCallbacks {
	/** 在选中状态发生变化后同步到模式状态、持久化、刷新 UI */
	onChange(): void;
}

/**
 * 显示分页式工具选择器。所有副作用（持久化、UI 刷新、激活工具）通过 callbacks.onChange 完成。
 */
export async function showToolSelector(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	accessor: SelectedToolNamesAccessor,
	policy: ToolSelectorPolicy,
	callbacks: ToolSelectorCallbacks,
) {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			formatToolSummary(computeActiveToolNames(pi, accessor, policy)),
			"info",
		);
		return;
	}

	let pageIndex = 0;
	while (true) {
		const tools = selectableTools(pi, policy);
		const pageCount = toolSelectorPageCount(tools);
		pageIndex = Math.min(pageIndex, pageCount - 1);
		const pageStart = pageIndex * TOOL_SELECTOR_PAGE_SIZE;
		const pageTools = tools.slice(
			pageStart,
			pageStart + TOOL_SELECTOR_PAGE_SIZE,
		);
		const selectedNames = resolveSelectedToolNames(tools, accessor, policy);
		const choices = pageTools.map((tool, index) =>
			formatToolChoice(tool, selectedNames.has(tool.name), pageStart + index),
		);
		const previousChoice = "Previous page";
		const nextChoice = "Next page";
		const doneChoice = "Done";
		const navigationChoices = [
			...(pageIndex > 0 ? [previousChoice] : []),
			...(pageIndex < pageCount - 1 ? [nextChoice] : []),
			doneChoice,
		];
		const choice = await ctx.ui.select(
			`${policy.modeName} mode tools (${pageIndex + 1}/${pageCount}). Non-built-in tools run at user risk.`,
			[...choices, ...navigationChoices],
		);
		if (!choice || choice === doneChoice) break;
		if (choice === previousChoice) {
			pageIndex = Math.max(0, pageIndex - 1);
			continue;
		}
		if (choice === nextChoice) {
			pageIndex = Math.min(pageCount - 1, pageIndex + 1);
			continue;
		}

		const selectedIndex = choices.indexOf(choice);
		const tool = pageTools[selectedIndex];
		if (!tool) continue;
		if (!canSelectToolInRestrictedMode(tool)) {
			ctx.ui.notify(
				`${tool.name} is blocked in ${policy.modeName} mode.`,
				"warning",
			);
			continue;
		}

		const nextSelectedNames = new Set(selectedNames);
		if (nextSelectedNames.has(tool.name)) nextSelectedNames.delete(tool.name);
		else nextSelectedNames.add(tool.name);

		accessor.set(
			filterAvailableSelectedNames(Array.from(nextSelectedNames), tools),
		);
		callbacks.onChange();
	}

	callbacks.onChange();
}
