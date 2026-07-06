// ─── 入口常量与导入 ─────────────────────────────────────────────

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
	extractProposedPlan,
	latestAssistantText,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
	unwrapSessionMessage,
} from "./shared/messages.js";
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
	buildActiveToolNames,
	computeActiveToolNames,
	deactivateRequiredTool,
	formatToolSummary,
	restoreTools,
	type SelectedToolNamesAccessor,
	selectableTools,
	showToolSelector,
	stripRequiredTool,
	type ToolSelectorPolicy,
	toolNameFromLegacyKey,
} from "./shared/tool-selector.js";
import type {
	CommandArgumentCompletion,
	SessionEntry,
} from "./shared/types.js";
import {
	isRecord,
	readCommand,
	scheduleAfterCurrentAgentRun,
	stringField,
} from "./shared/utils.js";

const STATE_ENTRY_TYPE = "plan-mode-state";
const STATUS_KEY = "plan-mode";
const PLAN_CONTEXT_MESSAGE_TYPE = "plan-mode-context";
const PROPOSED_PLAN_MESSAGE_TYPE = "proposed-plan";
const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
const PLAN_CONTEXT_MARKER = "[CODEX-LIKE PLAN MODE ACTIVE]";

const PLAN_SELECTOR_POLICY: ToolSelectorPolicy = {
	modeName: "Plan",
	requiredToolName: PLAN_MODE_QUESTION_TOOL_NAME,
};

// ─── 兼容旧测试导出 ─────────────────────────────────────────────

export function withRequiredPlanModeTools(toolNames: string[]) {
	return buildActiveToolNames(toolNames, PLAN_SELECTOR_POLICY);
}

export function withoutPlanModeQuestionTool(toolNames: string[]) {
	return stripRequiredTool(toolNames, PLAN_SELECTOR_POLICY);
}

export { canSelectToolInRestrictedMode as canSelectToolInPlanMode } from "./shared/tool-safety.js";
export {
	extractProposedPlan,
	isSafeCommand,
	latestAssistantText,
	stripProposedPlanBlocks,
	stripProposedPlanBlocksFromMessage,
};

// ─── 类型定义 ────────────────────────────────────────────────────

interface PlanModeState {
	enabled: boolean;
	latestPlan?: string;
	awaitingAction: boolean;
	availableTools?: string[];
	selectedToolKeys?: string[];
}

type PlanModeQuestionOption = {
	label: string;
	description?: string;
};

type PlanModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
};

type PlanModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
};

type PlanModeQuestionReason =
	| "cancelled"
	| "ui_unavailable"
	| "plan_mode_inactive"
	| "invalid_input";

type PlanModeQuestionDetails = {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	questions: PlanModeQuestion[];
	answers?: PlanModeQuestionAnswer[];
};

const PLAN_COMMAND_COMPLETIONS: readonly CommandArgumentCompletion[] = [
	{ value: "exit", label: "exit", description: "Exit Plan mode" },
	{ value: "off", label: "off", description: "Exit Plan mode" },
	{
		value: "tools",
		label: "tools",
		description: "Select tools allowed in Plan mode",
	},
];

const PLAN_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1, max 3.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "Stable identifier for mapping answers (snake_case).",
					},
					header: {
						type: "string",
						description:
							"Short header label shown in the UI (12 or fewer chars).",
					},
					question: {
						type: "string",
						description: "Single-sentence prompt shown to the user.",
					},
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"Provide 2-4 mutually exclusive choices. Put the recommended option first.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: {
									type: "string",
									description: "User-facing label (1-5 words).",
								},
								description: {
									type: "string",
									description:
										"One short sentence explaining impact/tradeoff if selected.",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

// ─── 旧测试期望的辅助函数（在此集中定义以兼容旧导入） ──────────

export function completePlanArguments(
	argumentPrefix: string,
): CommandArgumentCompletion[] | null {
	const prefix = argumentPrefix.trimStart().toLowerCase();
	if (prefix === "") return [...PLAN_COMMAND_COMPLETIONS];
	if (/\s/.test(prefix)) return null;
	const matches = PLAN_COMMAND_COMPLETIONS.filter((item) =>
		item.value.startsWith(prefix),
	);
	return matches.length > 0 ? [...matches] : null;
}

export function normalizePlanModeQuestionParams(input: unknown) {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false as const, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false as const, error: "questions must contain 1-3 items" };
	}
	const questions: PlanModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return {
				ok: false as const,
				error: `question ${questionIndex + 1} must be an object`,
			};
		}
		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return {
				ok: false as const,
				error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
			};
		}
		if (!Array.isArray(rawQuestion.options)) {
			return {
				ok: false as const,
				error: `question ${questionIndex + 1} options must be an array`,
			};
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return {
				ok: false as const,
				error: `question ${questionIndex + 1} options must contain 2-4 items`,
			};
		}
		const options: PlanModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return {
					ok: false as const,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
				};
			}
			const label = stringField(rawOption.label);
			if (!label) {
				return {
					ok: false as const,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
				};
			}
			const description = stringField(rawOption.description);
			if (!description) {
				return {
					ok: false as const,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
				};
			}
			options.push({ label, description });
		}
		questions.push({ id, header, question, options });
	}
	return { ok: true as const, questions };
}

// ─── 提示词（中文） ─────────────────────────────────────────────

function buildPlanModePrompt() {
	return `${PLAN_CONTEXT_MARKER}
# Plan Mode (Conversational)

You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until a developer or extension explicitly exits it.
- Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not use update_plan/TODO tooling in Plan Mode; Plan Mode is conversational planning, not execution progress tracking.
- Plan Mode manages built-in tool safety only. Non-built-in tools are disabled by default and may be enabled by the user at their own risk.
- Do not perform mutating actions: no edit/write tools, no patching, no formatting that rewrites files, no dependency installation, no commits, no migrations.

## Phase 1 — Ground in the environment

- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, run read-only checks, and resolve discoverable facts.
- Before asking the user any question, perform at least one targeted non-mutating exploration pass unless no local environment or repository is available.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Intent chat

- Keep asking until you can clearly state the goal, success criteria, in/out of scope, constraints, current state, and key preferences/tradeoffs.
- Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.

## Phase 3 — Implementation chat

- Once intent is stable, keep asking until the spec is decision-complete: approach, interfaces, data flow, edge cases/failure modes, testing and acceptance criteria, and any migration or compatibility constraints.
- Use plan_mode_question for important preferences, tradeoffs, or assumption locks that cannot be discovered by non-mutating exploration. Ask 1-3 concise questions with 2-4 meaningful options. Do not include filler options.
- If plan_mode_question returns cancelled or ui_unavailable, do not jump straight to a final plan when the missing answer is high impact. Ask one concise plain-text question or proceed only with a clearly stated low-risk assumption.

## Finalization rule

Only output the final plan when it is decision-complete and leaves no decisions to the implementer. When presenting the official plan, output exactly one proposed plan block and keep the tags exactly as shown:

<proposed_plan>
# Title

## Summary
...

## Key Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>

Keep the proposed plan concise, human and agent digestible, and free of open decisions. Do not ask "should I proceed?" in the final output; the Plan-mode ready menu handles implementation, staying in Plan mode, or exit.`;
}

// ─── 工具栏内的提问工具：回复载荷 ───────────────────────────────

function planModeQuestionAnswered(
	questions: PlanModeQuestion[],
	answers: PlanModeQuestionAnswer[],
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatPlanModeQuestionPayload({ cancelled: false, answers }),
			},
		],
		details: {
			cancelled: false,
			questions,
			answers,
		} satisfies PlanModeQuestionDetails,
	};
}

function planModeQuestionCancelled(
	questions: PlanModeQuestion[],
	reason: PlanModeQuestionReason,
	message: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatPlanModeQuestionPayload({
					cancelled: true,
					reason,
					message,
				}),
			},
		],
		details: {
			cancelled: true,
			reason,
			questions,
		} satisfies PlanModeQuestionDetails,
	};
}

function formatPlanModeQuestionPayload(payload: {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	message?: string;
	answers?: PlanModeQuestionAnswer[];
}) {
	return JSON.stringify(payload, null, 2);
}

async function askPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	const answers: PlanModeQuestionAnswer[] = [];
	const total = questions.length;
	for (const [index, question] of questions.entries()) {
		const choices = question.options.map(formatPlanModeQuestionChoice);
		const otherChoice = `${question.options.length + 1}. 其它（自由输入）`;
		const header =
			total > 1
				? `[${index + 1}/${total}] ${question.header}`
				: question.header;
		const choice = await ctx.ui.select(`${header}: ${question.question}`, [
			...choices,
			otherChoice,
		]);
		if (!choice) return undefined;

		if (choice === otherChoice) {
			const customAnswer = (await ctx.ui.editor(question.question, ""))?.trim();
			if (!customAnswer) return undefined;
			answers.push({
				id: question.id,
				header: question.header,
				question: question.question,
				answer: customAnswer,
				wasCustom: true,
			});
			continue;
		}

		const optionIndex = choices.indexOf(choice);
		const option = question.options[optionIndex];
		if (!option) return undefined;
		answers.push({
			id: question.id,
			header: question.header,
			question: question.question,
			answer: option.label,
			wasCustom: false,
			optionIndex: optionIndex + 1,
		});
	}
	return answers;
}

function formatPlanModeQuestionChoice(
	option: PlanModeQuestionOption,
	index: number,
) {
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

// ─── 历史消息中的 plan-mode 痕迹识别 ───────────────────────────

function messageContainsLegacyPlanModeContextArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return candidate.customType === PLAN_CONTEXT_MESSAGE_TYPE;
}

function messageContainsInactivePlanModeArtifact(message: unknown) {
	const candidate = unwrapSessionMessage(message);
	return candidate.customType === PROPOSED_PLAN_MESSAGE_TYPE;
}

// ═══════════════════════════════════════════════════════════════════
// 扩展入口
// ═══════════════════════════════════════════════════════════════════

export default function setupPlanMode(
	pi: ExtensionAPI,
	hooks: ModeHooks,
): ModeCallbacks {
	let state: PlanModeState = { enabled: false, awaitingAction: false };
	let previousTools: string[] | undefined;
	let cwd = process.cwd();

	const toolAccessor: SelectedToolNamesAccessor = {
		get: () => {
			if (state.availableTools !== undefined) return state.availableTools;
			if (state.selectedToolKeys !== undefined) {
				const tools = selectableTools(pi, PLAN_SELECTOR_POLICY);
				const migrated = state.selectedToolKeys
					.map((key) => toolNameFromLegacyKey(key, tools))
					.filter((name): name is string => name !== undefined);
				state = {
					...state,
					availableTools: migrated,
					selectedToolKeys: undefined,
				};
				return migrated;
			}
			return undefined;
		},
		set: (names) => {
			state = {
				...state,
				availableTools: names,
				selectedToolKeys: undefined,
			};
		},
	};

	pi.registerFlag("plan", {
		description: "Start in Codex-like Plan mode",
		type: "boolean",
		default: false,
	});

	pi.registerTool({
		name: PLAN_MODE_QUESTION_TOOL_NAME,
		label: "Plan question",
		description:
			"Ask the user one to three Plan-mode clarification questions with meaningful options, then wait for the answer. Only available while Plan mode is active.",
		promptSnippet: "Ask user decision questions while Plan mode is active",
		promptGuidelines: [
			"In Plan mode, use plan_mode_question for important preferences, tradeoffs, or assumptions that cannot be discovered from read-only exploration.",
		],
		parameters: PLAN_MODE_QUESTION_PARAMS,
		async execute(_toolCallId, params: unknown, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return planModeQuestionCancelled(
					[],
					"plan_mode_inactive",
					"Error: plan_mode_question is only available while Plan mode is active.",
				);
			}
			const parsed = normalizePlanModeQuestionParams(params);
			if (!parsed.ok) {
				return planModeQuestionCancelled(
					[],
					"invalid_input",
					`Error: ${parsed.error}`,
				);
			}
			if (!ctx.hasUI) {
				return planModeQuestionCancelled(
					parsed.questions,
					"ui_unavailable",
					"Unable to ask Plan-mode questions because interactive UI is not available.",
				);
			}
			const answers = await askPlanModeQuestions(parsed.questions, ctx);
			if (!answers) {
				return planModeQuestionCancelled(
					parsed.questions,
					"cancelled",
					"User cancelled the Plan-mode question prompt.",
				);
			}
			return planModeQuestionAnswered(parsed.questions, answers);
		},
	});

	pi.registerCommand("plan", {
		description: "Enter or manage Codex-like Plan mode",
		getArgumentCompletions: completePlanArguments,
		handler: async (args, ctx) => {
			const prompt = args.trim();
			const command = prompt.toLowerCase();
			if (command === "exit" || command === "off") {
				exitPlanMode(ctx);
				ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
				return;
			}
			if (command === "tools") {
				if (!state.enabled) enterPlanMode(ctx);
				await openToolSelector(ctx);
				return;
			}
			if (prompt) {
				enterPlanModeWithPrompt(prompt, ctx);
				return;
			}
			if (!state.enabled) {
				enterPlanMode(ctx);
				ctx.ui.notify(
					`Plan mode enabled.\n${currentToolSummary()}\nI will explore and plan, but not modify files.`,
					"info",
				);
				return;
			}
			await showPlanMenu(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			cwd = ctx.sessionManager.getCwd();
		} catch {
			// 忽略：保留默认值
		}
		restoreState(ctx);
		mergePersistedToolConfig();
		if (pi.getFlag("plan") === true) state.enabled = true;
		if (state.enabled) activatePlanModeTools();
		else deactivateRequiredTool(pi, PLAN_SELECTOR_POLICY);
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
				reason: `Plan mode blocks built-in mutating tool '${event.toolName}'. Use /plan and choose implementation when the plan is ready.`,
			};
		}
		if (event.toolName !== "bash" || !isBuiltinToolName(pi, event.toolName))
			return;

		const command = readCommand(event.input);
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode blocks mutating or non-allowlisted bash commands.\nCommand: ${command}`,
			};
		}
	});

	pi.on("context", async (event) => {
		const messagesWithoutLegacyPlanContext = event.messages.filter(
			(message: unknown) =>
				!messageContainsLegacyPlanModeContextArtifact(message),
		);
		if (state.enabled) return { messages: messagesWithoutLegacyPlanContext };
		return {
			messages: messagesWithoutLegacyPlanContext
				.filter(
					(message: unknown) =>
						!messageContainsInactivePlanModeArtifact(message),
				)
				.map(stripProposedPlanBlocksFromMessage),
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled) return;
		if (state.latestPlan || state.awaitingAction) {
			state = { ...state, latestPlan: undefined, awaitingAction: false };
			persistState();
			updateUi(ctx);
		}
		applyPlanModeTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildPlanModePrompt()}`,
		};
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!state.enabled) return;

		const text = latestAssistantText(event.messages);
		const proposedPlan = extractProposedPlan(text);
		if (!proposedPlan) {
			persistState();
			updateUi(ctx);
			return;
		}

		state = { ...state, latestPlan: proposedPlan, awaitingAction: true };
		persistState();
		updateUi(ctx);

		scheduleAfterCurrentAgentRun(async () => {
			if (!state.enabled || state.latestPlan !== proposedPlan) return;
			if (ctx.hasUI) await showPlanReadyMenu(ctx);
			if (!state.enabled || state.latestPlan !== proposedPlan) return;

			pi.sendMessage(
				{
					customType: PROPOSED_PLAN_MESSAGE_TYPE,
					content: `**Proposed Plan**\n\n${proposedPlan}`,
					display: true,
				},
				{ triggerTurn: false },
			);
		}, "Plan mode follow-up failed");
	});

	// ─── 内部动作函数 ──────────────────────────────────────────────

	function enterPlanMode(ctx: ExtensionContext) {
		hooks.onEnter(ctx);
		if (!state.enabled)
			previousTools = stripRequiredTool(
				safeGetActiveTools(),
				PLAN_SELECTOR_POLICY,
			);
		state = { ...state, enabled: true, awaitingAction: false };
		activatePlanModeTools();
		persistState();
		updateUi(ctx);
	}

	function enterPlanModeWithPrompt(prompt: string, ctx: ExtensionContext) {
		enterPlanMode(ctx);
		sendPlanModeUserMessage(prompt, ctx);
	}

	function exitPlanMode(ctx: ExtensionContext) {
		const wasEnabled = state.enabled;
		state = {
			...state,
			enabled: false,
			latestPlan: undefined,
			awaitingAction: false,
		};
		if (wasEnabled) restoreTools(pi, previousTools, PLAN_SELECTOR_POLICY);
		persistState();
		updateUi(ctx);
		hooks.onExit(ctx);
	}

	function sendPlanModeUserMessage(message: string, ctx: ExtensionContext) {
		if (ctx.isIdle()) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
	}

	function startImplementation(ctx: ExtensionContext) {
		const plan = state.latestPlan?.trim();
		exitPlanMode(ctx);

		if (!plan) {
			ctx.ui.notify(
				"Plan mode disabled. No proposed plan is available to implement.",
				"warning",
			);
			return;
		}

		sendPlanModeUserMessage(
			`Plan mode is now disabled. Full tool access is restored. Implement this proposed plan now:\n\n${plan}`,
			ctx,
		);
	}

	async function showPlanMenu(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify(planStatusText(), "info");
			return;
		}

		const choices = state.latestPlan
			? [
					"Show latest proposed plan",
					"Implement this plan",
					"Configure Plan-mode tools",
					"Stay in Plan mode",
					"Exit Plan mode",
				]
			: ["Configure Plan-mode tools", "Stay in Plan mode", "Exit Plan mode"];
		const choice = await ctx.ui.select(planStatusText(), choices);
		if (choice === "Show latest proposed plan") {
			ctx.ui.notify(state.latestPlan ?? "No proposed plan yet.", "info");
			return;
		}
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Configure Plan-mode tools") {
			await openToolSelector(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
			return;
		}
		updateUi(ctx);
	}

	async function showPlanReadyMenu(ctx: ExtensionContext) {
		const choice = await ctx.ui.select("Proposed plan ready. What next?", [
			"Implement this plan",
			"Stay in Plan mode",
			"Exit Plan mode",
		]);
		if (choice === "Implement this plan") {
			startImplementation(ctx);
			return;
		}
		if (choice === "Exit Plan mode") {
			exitPlanMode(ctx);
			ctx.ui.notify("Plan mode disabled. Proposed plan discarded.", "info");
		}
	}

	async function openToolSelector(ctx: ExtensionContext) {
		await showToolSelector(pi, ctx, toolAccessor, PLAN_SELECTOR_POLICY, {
			onChange: () => {
				applyPlanModeTools();
				persistState();
				persistToolConfig();
				updateUi(ctx);
			},
		});
	}

	function activatePlanModeTools() {
		previousTools ??= stripRequiredTool(
			safeGetActiveTools(),
			PLAN_SELECTOR_POLICY,
		);
		applyPlanModeTools();
	}

	function applyPlanModeTools() {
		pi.setActiveTools(
			computeActiveToolNames(pi, toolAccessor, PLAN_SELECTOR_POLICY),
		);
	}

	function safeGetActiveTools() {
		try {
			return pi.getActiveTools();
		} catch {
			return ["read", "bash"];
		}
	}

	function persistState() {
		const data: PlanModeState = {
			...state,
			availableTools: toolAccessor.get(),
		};
		pi.appendEntry<PlanModeState>(STATE_ENTRY_TYPE, data);
	}

	function restoreState(ctx: ExtensionContext) {
		const entries = ctx.sessionManager.getEntries() as SessionEntry[];
		const entry = entries
			.filter(
				(candidate) =>
					candidate.type === "custom" &&
					candidate.customType === STATE_ENTRY_TYPE,
			)
			.pop();
		if (!entry?.data || !isRecord(entry.data)) return;
		const data = entry.data as Partial<PlanModeState>;
		const enabled = data.enabled === true;
		state = {
			enabled,
			latestPlan: enabled ? (data.latestPlan as string | undefined) : undefined,
			awaitingAction: enabled ? data.awaitingAction === true : false,
			availableTools: Array.isArray(data.availableTools)
				? (data.availableTools.filter(
						(n: unknown) => typeof n === "string",
					) as string[])
				: undefined,
			selectedToolKeys: Array.isArray(data.selectedToolKeys)
				? (data.selectedToolKeys.filter(
						(n) => typeof n === "string",
					) as string[])
				: undefined,
		};
	}

	/** 将本地状态中没有持久化配置时，从磁盘配置中加载并合并。 */
	function mergePersistedToolConfig() {
		if (state.availableTools && state.availableTools.length > 0) return;
		const persisted = loadModeToolConfig("plan", cwd);
		if (persisted.availableTools && persisted.availableTools.length > 0) {
			state = { ...state, availableTools: persisted.availableTools };
		}
	}

	function updateUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, formatStatus());
	}

	function formatStatus() {
		if (!state.enabled) return undefined;
		if (state.awaitingAction || state.latestPlan) return "plan ready";
		return "plan";
	}

	function clearUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function planStatusText() {
		if (!state.enabled) return "Plan mode is off.";
		if (state.latestPlan)
			return `Plan mode is active and a proposed plan is ready. ${currentToolSummary()}`;
		return `Plan mode is active. ${currentToolSummary()} Explore, ask, and produce a <proposed_plan> block.`;
	}

	function currentToolSummary() {
		return formatToolSummary(
			computeActiveToolNames(pi, toolAccessor, PLAN_SELECTOR_POLICY),
		);
	}

	// 每次切换工具集合后落盘
	function persistToolConfig() {
		const names = toolAccessor.get();
		if (!names) return;
		saveModeToolConfig("plan", cwd, { availableTools: names });
	}

	return { enter: enterPlanMode, exit: exitPlanMode, clearUi };
}
