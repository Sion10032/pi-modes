// ─── 模式互斥相关类型 ──────────────────────────────────────

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** 模式名称 */
export type ModeName = "plan" | "readonly";

/** 模式回调：setup 函数返回给 index.ts 编排用 */
export interface ModeCallbacks {
	enter: (ctx: ExtensionContext) => void;
	exit: (ctx: ExtensionContext) => void;
	clearUi: (ctx: ExtensionContext) => void;
}

/** 模式钩子：index.ts 传入 setup 函数，用于通知编排层 */
export interface ModeHooks {
	onEnter: (ctx: ExtensionContext) => void;
	onExit: (ctx: ExtensionContext) => void;
}
