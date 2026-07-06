import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "./utils.js";

// 工具配置持久化：
// - 单一配置文件：<cwd>/.pi/pi-modes.json，缺失时回退 ~/.pi/pi-modes.json
// - 写入：优先用户级，仅当项目级文件已存在时修改项目级
// - 配置按 mode（plan / readonly）独立存储：
//     {
//       "plan":    { "availableTools": [...] },
//       "readonly": { "availableTools": [...] }
//     }

export const TOOL_CONFIG_FILENAME = "pi-modes.json";

export type ModeKey = "plan" | "readonly";

export interface ModeToolConfig {
	availableTools?: string[];
}

interface ToolConfigFile {
	plan?: ModeToolConfig;
	readonly?: ModeToolConfig;
}

interface ToolConfigLocations {
	projectPath: string;
	userPath: string;
}

function resolveLocations(cwd: string): ToolConfigLocations {
	return {
		projectPath: join(cwd, ".pi", TOOL_CONFIG_FILENAME),
		userPath: join(homedir(), ".pi", TOOL_CONFIG_FILENAME),
	};
}

/** 读取某个 mode 的工具配置：项目级优先，缺失时回退到用户级 */
export function loadModeToolConfig(mode: ModeKey, cwd: string): ModeToolConfig {
	return readConfigFile(cwd)[mode] ?? {};
}

/** 保存某个 mode 的工具配置：优先用户级，仅当项目级文件已存在时写入项目级 */
export function saveModeToolConfig(
	mode: ModeKey,
	cwd: string,
	config: ModeToolConfig,
): void {
	const { projectPath, userPath } = resolveLocations(cwd);
	const current = readConfigFile(cwd);
	const next: ToolConfigFile = { ...current, [mode]: config };
	const serialized = `${JSON.stringify(next, null, 2)}\n`;
	// 仅当项目级文件已存在时写入项目级
	if (existsSync(projectPath) && writeJsonFile(projectPath, serialized)) return;
	// 否则写入用户级
	writeJsonFile(userPath, serialized);
}

function readConfigFile(cwd: string): ToolConfigFile {
	const { projectPath, userPath } = resolveLocations(cwd);
	return parseConfigFile(projectPath) ?? parseConfigFile(userPath) ?? {};
}

function parseConfigFile(path: string): ToolConfigFile | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) return undefined;
		return extractConfigFile(parsed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`读取工具配置失败 (${path})：${message}`);
		return undefined;
	}
}

function extractConfigFile(parsed: Record<string, unknown>): ToolConfigFile {
	const file: ToolConfigFile = {};
	for (const mode of ["plan", "readonly"] as const) {
		const candidate = parsed[mode];
		if (!isRecord(candidate)) continue;
		const selected = candidate.availableTools;
		if (
			Array.isArray(selected) &&
			selected.every((value) => typeof value === "string")
		) {
			file[mode] = { availableTools: selected };
		}
	}
	return file;
}

function writeJsonFile(path: string, content: string): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`保存工具配置失败 (${path})：${message}`);
		return false;
	}
}
