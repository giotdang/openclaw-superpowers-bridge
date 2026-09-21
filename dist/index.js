/**
 * Superpowers Bridge Plugin for OpenClaw
 *
 * Automatically fetches and manages Superpowers workflow skills from GitHub
 * and injects the relevant ones into the agent prompt.
 *
 * Based on https://github.com/obra/superpowers
 * Originally by vruru (https://github.com/vruru/superpowers-bridge), MIT.
 *
 * OpenClaw-hardened fork:
 *  - Uses the non-deprecated `before_prompt_build` hook (was `before_agent_start`)
 *  - Correct agent-tool shape (label + execute(toolCallId, params)) for the
 *    current plugin SDK
 *  - Vietnamese + English keyword detection (word-boundary aware for ASCII)
 *  - Cost control: `injectionMode` (summary|full), `maxInjectedChars`,
 *    `injectOncePerSession`
 *  - Manifest declares `contracts.tools` + `activation.onStartup` so the tools
 *    are discoverable before runtime load
 *
 * No external runtime dependencies (only Node built-ins), so it loads without
 * an npm install step.
 */
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DEFAULT_SKILLS_REPO = "https://github.com/obra/superpowers.git";
const SKILLS_SUBDIR = "skills";
const CACHE_DIR_NAME = ".superpowers-cache";
/**
 * Keyword map: skill name -> trigger keywords.
 * ASCII keywords are matched on word boundaries; non-ASCII (Vietnamese etc.)
 * are matched with plain substring matching.
 */
const DEFAULT_KEYWORDS = {
    brainstorming: [
        "写代码", "编写", "实现", "开发", "创建", "构建", "功能",
        "write code", "implement", "develop", "create", "build", "function", "class",
        "script", "program", "app", "feature",
        // Vietnamese
        "viết code", "viết hàm", "viết chương trình", "viết script", "lập trình",
        "xây dựng", "phát triển", "tính năng", "chức năng", "ý tưởng", "bàn bạc",
        "triển khai", "tạo mới", "làm cái", "làm cái gì",
    ],
    "writing-plans": [
        "计划", "规划", "方案", "plan", "spec", "设计", "design",
        // Vietnamese
        "kế hoạch", "lập kế hoạch", "lên kế hoạch", "phương án", "lộ trình",
        "thiết kế", "đặc tả",
    ],
    "subagent-driven-development": [
        "执行", "implement", "execute", "task",
        // Vietnamese
        "tác vụ", "subagent", "chia việc",
    ],
    "test-driven-development": [
        "测试", "test", "tdd", "unittest", "jest", "mocha",
        // Vietnamese
        "kiểm thử", "viết test", "unit test", "kiểm thử tự động",
    ],
    "systematic-debugging": [
        "调试", "debug", "修复", "fix", "bug", "错误", "error", "issue",
        // Vietnamese
        "sửa lỗi", "gỡ lỗi", "tìm lỗi", "bị lỗi", "báo lỗi", "không chạy",
        "crash", "lỗi",
    ],
    "using-git-worktrees": [
        "分支", "branch", "worktree", "git",
        // Vietnamese
        "nhánh",
    ],
    "finishing-a-development-branch": [
        "完成", "结束", "合并", "merge", "pr", "pull request",
        // Vietnamese
        "hợp nhất", "tạo pr", "gộp nhánh",
    ],
};
const ALWAYS_LOAD_SKILLS = ["using-superpowers"];
// ---------------------------------------------------------------------------
// Cache / git helpers
// ---------------------------------------------------------------------------
function getCacheDir() {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    return path.join(pluginDir, CACHE_DIR_NAME);
}
function getSkillsDir(cacheDir) {
    return path.join(cacheDir, SKILLS_SUBDIR);
}
function ensureSkills(repoUrl, logger) {
    const cacheDir = getCacheDir();
    const skillsDir = getSkillsDir(cacheDir);
    if (fs.existsSync(path.join(cacheDir, ".git"))) {
        return { success: true, skillsDir, message: "Skills already cached" };
    }
    logger.info(`[Superpowers Bridge] First run - cloning skills from ${repoUrl}...`);
    try {
        const parentDir = path.dirname(cacheDir);
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        execSync(`git clone --depth 1 "${repoUrl}" "${cacheDir}"`, {
            stdio: "pipe",
            timeout: 60000,
        });
        logger.info(`[Superpowers Bridge] Successfully cloned skills to ${cacheDir}`);
        return { success: true, skillsDir, message: "Skills cloned successfully" };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[Superpowers Bridge] Failed to clone skills: ${message}`);
        return { success: false, skillsDir, message: `Clone failed: ${message}` };
    }
}
function updateSkills(logger) {
    const cacheDir = getCacheDir();
    if (!fs.existsSync(path.join(cacheDir, ".git"))) {
        return { success: false, message: "Skills not yet cloned. Plugin will auto-clone on next start." };
    }
    try {
        logger.info("[Superpowers Bridge] Updating skills...");
        const output = execSync("git pull --ff-only", {
            cwd: cacheDir,
            stdio: "pipe",
            encoding: "utf-8",
            timeout: 30000,
        });
        logger.info(`[Superpowers Bridge] Skills updated: ${String(output).trim()}`);
        return { success: true, message: String(output).trim() || "Already up to date" };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`[Superpowers Bridge] Failed to update skills: ${message}`);
        return { success: false, message: `Update failed: ${message}` };
    }
}
function getSkillsVersion(logger) {
    const cacheDir = getCacheDir();
    if (!fs.existsSync(path.join(cacheDir, ".git"))) {
        return { success: false, version: "", message: "Skills not yet cloned" };
    }
    try {
        const commit = execSync("git rev-parse --short HEAD", {
            cwd: cacheDir,
            stdio: "pipe",
            encoding: "utf-8",
        }).trim();
        const date = execSync("git log -1 --format=%cd", {
            cwd: cacheDir,
            stdio: "pipe",
            encoding: "utf-8",
        }).trim();
        return { success: true, version: commit, message: `Skills version: ${commit} (${date})` };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, version: "", message: `Failed to get version: ${message}` };
    }
}
// ---------------------------------------------------------------------------
// Skill parsing
// ---------------------------------------------------------------------------
function parseSkill(content, filename, logger) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        logger.warn(`[Superpowers Bridge] No frontmatter found in ${filename}`);
        return null;
    }
    const frontmatterStr = match[1];
    const body = match[2].trim();
    const nameMatch = frontmatterStr.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatterStr.match(/^description:\s*([\s\S]*?)(?:\n\w|\s*$)/m);
    if (!nameMatch) {
        logger.warn(`[Superpowers Bridge] No name in frontmatter of ${filename}`);
        return null;
    }
    const clean = (s) => s.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
    return {
        name: clean(nameMatch[1]),
        description: descMatch ? clean(descMatch[1]) : "",
        content: body,
    };
}
function loadSkills(skillsDir, logger) {
    const skills = new Map();
    if (!fs.existsSync(skillsDir)) {
        logger.warn(`[Superpowers Bridge] Skills directory not found: ${skillsDir}`);
        return skills;
    }
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillPath))
            continue;
        try {
            const content = fs.readFileSync(skillPath, "utf-8");
            const skill = parseSkill(content, entry.name, logger);
            if (skill) {
                skills.set(skill.name, skill);
                logger.debug?.(`[Superpowers Bridge] Loaded skill: ${skill.name}`);
            }
        }
        catch (err) {
            logger.error(`[Superpowers Bridge] Failed to load ${skillPath}:`, err);
        }
    }
    return skills;
}
// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
const ASCII_KEYWORD = /^[a-z0-9][a-z0-9 _-]*$/i;
function matchesKeyword(haystackLower, keyword) {
    const kw = keyword.toLowerCase().trim();
    if (!kw)
        return false;
    if (ASCII_KEYWORD.test(kw)) {
        // Word-boundary match to avoid false positives like "app" in "application".
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i");
        return re.test(haystackLower);
    }
    // Non-ASCII (Vietnamese, CJK): substring match.
    return haystackLower.includes(kw);
}
function detectRelevantSkills(prompt, skills, keywords, whitelist, defaultSkill) {
    const promptLower = prompt.toLowerCase();
    const relevant = new Set();
    // Bootstrap skill (if present). Honors a custom default.
    for (const name of new Set([defaultSkill, ...ALWAYS_LOAD_SKILLS])) {
        if (name && skills.has(name))
            relevant.add(name);
    }
    for (const [skillName, kws] of Object.entries(keywords)) {
        if (whitelist && whitelist.length > 0 && !whitelist.includes(skillName))
            continue;
        if (!skills.has(skillName))
            continue;
        if (kws.some((kw) => matchesKeyword(promptLower, kw))) {
            relevant.add(skillName);
        }
    }
    return Array.from(relevant);
}
// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------
const TOOL_MAPPING = [
    "## Tool Mapping (Superpowers -> OpenClaw)",
    "",
    "- TodoWrite -> track tasks via notes",
    "- Task / subagent dispatch -> `sessions_spawn` with runtime \"subagent\"",
    "- Bash -> `exec` tool",
    "- Read -> `read` tool",
    "- Edit -> `edit` tool",
    "- Write -> `write` tool",
    "- Skill -> `superpowers_skill` tool (provided by this plugin)",
    "",
    "**Remember**: follow the loaded skills exactly. They are mandatory workflows, not suggestions.",
].join("\n");
function buildSkillsContext(skills, skillNames, mode, maxChars) {
    const sections = [];
    sections.push("# Superpowers Workflow");
    sections.push("");
    sections.push("The following Superpowers skills are relevant to this task.");
    if (mode === "summary") {
        sections.push("Load a full skill with the `superpowers_skill` tool before applying it.");
        sections.push("");
        for (const name of skillNames) {
            const skill = skills.get(name);
            if (!skill)
                continue;
            sections.push(`- **${skill.name}**${skill.description ? ` — ${skill.description}` : ""}`);
        }
    }
    else {
        for (const name of skillNames) {
            const skill = skills.get(name);
            if (!skill)
                continue;
            sections.push("");
            sections.push(`## ${skill.name}`);
            if (skill.description)
                sections.push(`*${skill.description}*`);
            sections.push("");
            sections.push(skill.content);
            sections.push("");
            sections.push("---");
        }
    }
    sections.push("");
    sections.push(TOOL_MAPPING);
    let out = sections.join("\n");
    if (maxChars > 0 && out.length > maxChars) {
        out =
            out.slice(0, maxChars).trimEnd() +
                "\n\n_[Superpowers Bridge: context truncated to maxInjectedChars. Use the `superpowers_skill` tool to load any skill in full.]_";
    }
    return out;
}
// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------
const superpowersBridgePlugin = {
    id: "superpowers-bridge",
    name: "Superpowers Bridge",
    description: "Bridge to Superpowers workflow skills - auto-fetches from GitHub and injects relevant skills",
    register(api) {
        const config = (api.pluginConfig || {});
        const logger = api.logger ?? console;
        if (config.enabled === false) {
            logger.info("[Superpowers Bridge] Plugin disabled via config");
            return;
        }
        const repoUrl = config.skillsRepo || DEFAULT_SKILLS_REPO;
        const autoDetect = config.autoDetectCode !== false;
        const injectionMode = config.injectionMode === "full" ? "full" : "summary";
        const maxInjectedChars = typeof config.maxInjectedChars === "number" ? config.maxInjectedChars : 3600;
        const injectOncePerSession = config.injectOncePerSession !== false;
        const defaultSkill = config.defaultSkill || "using-superpowers";
        const keywords = { ...DEFAULT_KEYWORDS };
        if (config.extraKeywords) {
            for (const [skillName, kws] of Object.entries(config.extraKeywords)) {
                keywords[skillName] = [...(keywords[skillName] ?? []), ...kws];
            }
        }
        // Fetch + load
        const { success, skillsDir, message } = ensureSkills(repoUrl, logger);
        if (!success) {
            logger.error(`[Superpowers Bridge] Failed to initialize: ${message}`);
        }
        const skills = loadSkills(skillsDir, logger);
        logger.info(`[Superpowers Bridge] Loaded ${skills.size} skills from ${skillsDir}`);
        if (skills.size === 0 && success) {
            logger.warn(`[Superpowers Bridge] No skills found in ${skillsDir}`);
        }
        if (config.autoUpdate) {
            const r = updateSkills(logger);
            logger.info(`[Superpowers Bridge] autoUpdate: ${r.message}`);
            if (r.success) {
                const reloaded = loadSkills(skillsDir, logger);
                skills.clear();
                for (const [n, s] of reloaded)
                    skills.set(n, s);
            }
        }
        // Per-session de-dup to avoid re-injecting the same skill every turn.
        const injectedBySession = new Map();
        const MAX_TRACKED_SESSIONS = 500;
        api.on("before_prompt_build", (event, ctx) => {
            if (skills.size === 0)
                return {};
            const prompt = event?.prompt || "";
            if (!prompt.trim())
                return {};
            const relevant = autoDetect
                ? detectRelevantSkills(prompt, skills, keywords, config.autoSelectSkills, defaultSkill)
                : [defaultSkill].filter((n) => skills.has(n));
            if (relevant.length === 0)
                return {};
            const sessionKey = ctx?.sessionKey || ctx?.sessionId || "default";
            if (injectOncePerSession) {
                let seen = injectedBySession.get(sessionKey);
                if (!seen) {
                    seen = new Set();
                    injectedBySession.set(sessionKey, seen);
                    if (injectedBySession.size > MAX_TRACKED_SESSIONS) {
                        const first = injectedBySession.keys().next().value;
                        if (first !== undefined)
                            injectedBySession.delete(first);
                    }
                }
                const fresh = relevant.filter((n) => !seen.has(n));
                if (fresh.length === 0)
                    return {};
                fresh.forEach((n) => seen.add(n));
                return {
                    prependContext: buildSkillsContext(skills, fresh, injectionMode, maxInjectedChars),
                };
            }
            return {
                prependContext: buildSkillsContext(skills, relevant, injectionMode, maxInjectedChars),
            };
        });
        // Tool: load a skill explicitly
        api.registerTool({
            name: "superpowers_skill",
            label: "Superpowers Skill",
            description: "Load the full text of a Superpowers workflow skill by name. Use when a Superpowers skill is relevant to the task.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Name of the skill to load, e.g. brainstorming, test-driven-development",
                    },
                },
                required: ["name"],
            },
            async execute(_toolCallId, params) {
                const name = String(params?.name ?? "").trim();
                const skill = skills.get(name);
                if (!skill) {
                    const available = Array.from(skills.keys()).sort().join(", ");
                    return {
                        content: [{ type: "text", text: `Skill '${name}' not found. Available: ${available}` }],
                        details: { found: false, available: Array.from(skills.keys()) },
                    };
                }
                return {
                    content: [{ type: "text", text: skill.content }],
                    details: { found: true, name: skill.name, description: skill.description },
                };
            },
        });
        // Tool: update skills
        api.registerTool({
            name: "update_superpowers_skills",
            label: "Update Superpowers Skills",
            description: "Pull the latest Superpowers skills from GitHub (git pull) and reload them.",
            parameters: { type: "object", properties: {} },
            async execute() {
                const result = updateSkills(logger);
                if (result.success) {
                    const reloaded = loadSkills(skillsDir, logger);
                    skills.clear();
                    for (const [n, s] of reloaded)
                        skills.set(n, s);
                    logger.info(`[Superpowers Bridge] Reloaded ${skills.size} skills after update`);
                }
                return {
                    content: [{ type: "text", text: result.message }],
                    details: result,
                };
            },
        });
        // Tool: version
        api.registerTool({
            name: "superpowers_version",
            label: "Superpowers Version",
            description: "Report the currently loaded Superpowers skills version (git commit + date).",
            parameters: { type: "object", properties: {} },
            async execute() {
                const result = getSkillsVersion(logger);
                return {
                    content: [{ type: "text", text: result.message }],
                    details: { ...result, loadedSkills: skills.size },
                };
            },
        });
        logger.info("[Superpowers Bridge] Registered tools: superpowers_skill, update_superpowers_skills, superpowers_version");
    },
};
export default superpowersBridgePlugin;
