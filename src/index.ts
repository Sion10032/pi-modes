// ─── Plan-mode + Read-only-mode 统一入口 ─────────────────────
//
// index.ts 负责编排：管理模式状态，在模式切换时调用
// plan-mode / readonly-mode 提供的回调。

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import setupPlanMode from "./plan-mode.js";
import setupReadonlyMode from "./readonly-mode.js";
import type { ModeCallbacks, ModeName } from "./shared/mode-types.js";

let activeMode: ModeName | null = null;
const modeCallbacks: Partial<Record<ModeName, ModeCallbacks>> = {};

function exitOtherMode(currentMode: ModeName, ctx: ExtensionContext): void {
	if (!activeMode || activeMode === currentMode) return;
	const old = modeCallbacks[activeMode];
	if (old) {
		if (ctx.hasUI) old.clearUi(ctx);
		old.exit(ctx);
	}
}

function createModeHooks(mode: ModeName) {
	return {
		onEnter: (ctx: ExtensionContext) => {
			exitOtherMode(mode, ctx);
			activeMode = mode;
		},
		onExit: (_ctx: ExtensionContext) => {
			if (activeMode === mode) {
				activeMode = null;
			}
		},
	};
}

export default function extension(pi: ExtensionAPI) {
	const planHooks = createModeHooks("plan");
	const readonlyHooks = createModeHooks("readonly");

	const plan = setupPlanMode(pi, planHooks);
	const readonly = setupReadonlyMode(pi, readonlyHooks);

	modeCallbacks.plan = plan;
	modeCallbacks.readonly = readonly;
}
