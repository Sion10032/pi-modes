// ─── 只读模式入口 ──────────────────────────────────────────────

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ModeCallbacks, ModeHooks } from "./shared/mode-types.js";
import {
	loadModeToolConfig,
	saveModeToolConfig,
} from "./shared/tool-config.js";
import {
	isBlockedBuiltinToolName,
	isBuiltinToolName,
	isSafeCommand,
} from "./shared/tool-safety.js";
import {
	computeActiveToolNames,
	deactivateRequiredTool,
	formatToolSummary,
	restoreTools,
	type SelectedToolNamesAccessor,
	showToolSelector,
	stripRequiredTool,
	type ToolSelectorPolicy,
} from "./shared/tool-selector.js";
import type { CommandArgumentCompletion } from "./shared/types.js";
import { readCommand } from "./shared/utils.js";

// 只读模式复用 plan-mode 的工具/bash 安全策略，但精简了提示词与 UI
const STATE_ENTRY_TYPE = "readonly-mode-state";
const STATUS_KEY = "readonly-mode";
const READONLY_CONTEXT_MARKER = "[READONLY MODE ACTIVE]";
const READONLY_SELECTOR_POLICY: ToolSelectorPolicy = {
	modeName: "Read-only",
};

interface ReadonlyModeState {
	enabled: boolean;
	availableTools?: string[];
}

const READONLY_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "exit", label: "exit", description: "Exit Read-only mode" },
	{ value: "off", label: "off", description: "Exit Read-only mode" },
	{
		value: "tools",
		label: "tools",
		description: "Select tools allowed in Read-only mode",
	},
];

export function completeReadonlyArguments(
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...READONLY_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;
	const matches = READONLY_COMMAND_COMPLETIONS.filter((item) =>
		item.value.startsWith(prefix),
	);
	return matches.length > 0 ? [...matches] : null;
}

function buildReadonlyPrompt() {
	return `${READONLY_CONTEXT_MARKER}
# 只读模式

你当前处于只读模式。该模式复用了规划模式的工具安全策略：

- 只能使用内置的只读工具（read/grep/find/ls）以及受 bash 白名单限制的只读 bash 命令。
- 禁止使用 edit/write、禁止执行变更类或写外存的 bash 命令、禁止调用非白名单中的修改类扩展工具。
- 不需要产出实施计划，也不需要调用任何 plan_mode_question 类的提问工具。
- 只读模式仅负责以安全的方式理解代码与现状，不会推进任何变更。

如果用户要求修改文件或执行变更，请明确告知他们需要先退出只读模式。`;
}

// ═══════════════════════════════════════════════════════════════════
// 扩展入口
// ═══════════════════════════════════════════════════════════════════

export default function setupReadonlyMode(
	pi: ExtensionAPI,
	hooks: ModeHooks,
): ModeCallbacks {
	let state: ReadonlyModeState = { enabled: false };
	let previousTools: string[] | undefined;
	let cwd = process.cwd();

	const toolAccessor: SelectedToolNamesAccessor = {
		get: () => state.availableTools,
		set: (names) => {
			state = { ...state, availableTools: names };
		},
	};

	pi.registerFlag("ro", {
		description: "Start in Read-only mode",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("ro", {
		description: "Enter or exit Read-only mode (toggle)",
		getArgumentCompletions: completeReadonlyArguments,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const command = prompt.toLowerCase();

			// /ro exit / off — 显式退出
			if (command === "exit" || command === "off") {
				if (state.enabled) {
					exitReadonlyMode(ctx);
					ctx.ui.notify(
						"Read-only mode disabled. Original tools restored.",
						"info",
					);
				} else {
					ctx.ui.notify("Read-only mode is already off.", "info");
				}
				return;
			}

			// /ro tools — 配置只读模式允许的工具
			if (command === "tools") {
				if (!state.enabled) enterReadonlyMode(ctx);
				await openToolSelector(ctx);
				return;
			}

			// 传入其他参数 — 视为“进入只读模式并发送这条消息”
			if (prompt) {
				const wasEnabled = state.enabled;
				if (!wasEnabled) enterReadonlyMode(ctx);
				sendReadonlyUserMessage(prompt, ctx);
				return;
			}

			// /ro — 智能切换
			if (state.enabled) {
				exitReadonlyMode(ctx);
				ctx.ui.notify(
					"Read-only mode disabled. Original tools restored.",
					"info",
				);
			} else {
				enterReadonlyMode(ctx);
				ctx.ui.notify(
					`Read-only mode enabled.\n${currentToolSummary()}\nI will read and search, but not modify files.`,
					"info",
				);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			cwd = ctx.sessionManager.getCwd();
		} catch {
			// 保留 process.cwd() 默认值
		}
		restoreState(ctx);
		mergePersistedToolConfig();
		if (pi.getFlag("ro") === true) state.enabled = true;
		if (state.enabled) activateReadonlyModeTools();
		else deactivateRequiredTool(pi, READONLY_SELECTOR_POLICY);
		updateUi(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		persistState();
		clearUi(ctx);
	});

	pi.on("tool_call", async (event) => {
		if (!state.enabled) return;
		if (isBlockedBuiltinToolName(pi, event.toolName)) {
			return {
				block: true,
				reason: `Read-only mode blocks built-in mutating tool '${event.toolName}'. Use /ro to exit Read-only mode first.`,
			};
		}
		if (event.toolName !== "bash" || !isBuiltinToolName(pi, event.toolName))
			return;

		const command = readCommand(event.input);
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Read-only mode blocks mutating or non-allowlisted bash commands.\nCommand: ${command}`,
			};
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!state.enabled) return;
		applyReadonlyModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildReadonlyPrompt()}`,
		};
	});

	// ─── 内部动作 ────────────────────────────────────────────────

	function enterReadonlyMode(ctx: ExtensionContext) {
		hooks.onEnter(ctx);
		if (!state.enabled)
			previousTools = stripRequiredTool(
				safeGetActiveTools(),
				READONLY_SELECTOR_POLICY,
			);
		state = { ...state, enabled: true };
		activateReadonlyModeTools();
		persistState();
		updateUi(ctx);
	}

	function exitReadonlyMode(ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		state = { ...state, enabled: false };
		if (wasEnabled) restoreTools(pi, previousTools, READONLY_SELECTOR_POLICY);
		persistState();
		updateUi(ctx);
		hooks.onExit(ctx);
	}

	function sendReadonlyUserMessage(message: string, ctx: ExtensionContext) {
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	function activateReadonlyModeTools() {
		previousTools ??= stripRequiredTool(
			safeGetActiveTools(),
			READONLY_SELECTOR_POLICY,
		);
		applyReadonlyModeTools();
	}

	function applyReadonlyModeTools() {
		pi.setActiveTools(
			computeActiveToolNames(pi, toolAccessor, READONLY_SELECTOR_POLICY),
		);
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return ["read", "bash"];
		}
	}

	async function openToolSelector(ctx: ExtensionContext) {
		await showToolSelector(pi, ctx, toolAccessor, READONLY_SELECTOR_POLICY, {
			onChange: () => {
				applyReadonlyModeTools();
				persistState();
				persistToolConfig();
				updateUi(ctx);
			},
		});
	}

	function persistState() {
		const data: ReadonlyModeState = {
			...state,
			availableTools: toolAccessor.get(),
		};
		pi.appendEntry<ReadonlyModeState>(STATE_ENTRY_TYPE, data);
	}

	function restoreState(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>;
		const entry = entries
			.filter(
				(candidate) =>
					candidate.type === "custom" &&
					candidate.customType === STATE_ENTRY_TYPE,
			)
			.pop();
		if (!entry?.data || typeof entry.data !== "object") return;
		const data = entry.data as Partial<ReadonlyModeState>;
		state = {
			enabled: data.enabled === true,
			availableTools: Array.isArray(data.availableTools)
				? (data.availableTools.filter(
						(n: unknown) => typeof n === "string",
					) as string[])
				: undefined,
		};
	}

	function mergePersistedToolConfig() {
		if (state.availableTools && state.availableTools.length > 0) return;
		const persisted = loadModeToolConfig("readonly", cwd);
		if (persisted.availableTools && persisted.availableTools.length > 0) {
			state = { ...state, availableTools: persisted.availableTools };
		}
	}

	function persistToolConfig() {
		const names = toolAccessor.get();
		if (!names) return;
		saveModeToolConfig("readonly", cwd, {
			availableTools: names,
		});
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, formatStatus());
	}

	function formatStatus() {
		return state.enabled ? "readonly" : undefined;
	}

	function clearUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function currentToolSummary() {
		return formatToolSummary(
			computeActiveToolNames(pi, toolAccessor, READONLY_SELECTOR_POLICY),
		);
	}

	return { enter: enterReadonlyMode, exit: exitReadonlyMode, clearUi };
}
