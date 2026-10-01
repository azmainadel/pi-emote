import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Config } from "./types.js";
import type { Animator } from "./animator.js";
import type { RenderedFrame } from "./renderer.js";
import { log } from "./log.js";

// --- Token formatting ---

function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

const PROVIDER_ALIASES: Record<string, string> = {
  "openai-codex": "codex", "claude-bridge": "claude", anthropic: "claude",
  kiro: "kiro", zai: "glm", "zai-coding": "glm", "zai-coding-cn": "glm",
  openrouter: "openrouter", "kimi-coding": "kimi", moonshot: "kimi", xai: "grok",
};
let providerAliasCache: Record<string, string> | undefined;
function providerAliases(): Record<string, string> {
  if (providerAliasCache) return providerAliasCache;
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".pi/agent/pi-glance.json"), "utf8"));
    const aliases = config?.providerAliases;
    if (aliases && typeof aliases === "object" && !Array.isArray(aliases)) {
      for (const [key, value] of Object.entries(aliases)) {
        if (typeof value === "string" && value.trim()) PROVIDER_ALIASES[key.toLowerCase()] = value.trim();
      }
    }
  } catch { /* Optional pi-glance aliases; fall back to built-in labels. */ }
  providerAliasCache = PROVIDER_ALIASES;
  return providerAliasCache;
}

function sessionUsage(entries: any[]): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    let usage: any;
    if (entry.type === "usage") usage = entry.usage;
    else if (entry.type === "message" && ["assistant", "toolResult"].includes(entry.message?.role)) usage = entry.message.usage;
    else if (entry.type === "branch_summary" || entry.type === "compaction") usage = entry.usage;
    if (!usage) continue;
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    totals.cost += usage.cost?.total ?? 0;
  }
  return totals;
}

// --- Session metadata helpers ---

/** Compact elapsed time: "42m" below an hour, "1h 5m" above. */
function formatElapsed(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Session start time from the earliest timestamped entry; falls back to now. */
function sessionStartMs(entries: any[]): number {
  for (const e of entries) {
    const ts = e?.timestamp ?? e?.message?.timestamp;
    if (typeof ts === "string") {
      const t = Date.parse(ts);
      if (!Number.isNaN(t)) return t;
    }
  }
  return Date.now();
}

let sessionStartCache = 0;
function cachedSessionStartMs(entries: any[]): number {
  if (!sessionStartCache) sessionStartCache = sessionStartMs(entries);
  return sessionStartCache;
}

/** Turn count = number of user messages this session. */
function countTurns(entries: any[]): number {
  let n = 0;
  for (const e of entries) {
    if (e?.type === "message" && e?.message?.role === "user") n++;
  }
  return n;
}

function compactDirectory(cwd: string): string {
  const parts = resolve(cwd).split(sep).filter(Boolean);
  return `/${parts.slice(-2).join(sep)}`;
}

const branchCache = new Map<string, { checkedAt: number; branch: string }>();
function getGitBranch(cwd: string): string {
  const cached = branchCache.get(cwd);
  if (cached && Date.now() - cached.checkedAt < 2_000) return cached.branch;
  let branch = "";
  try {
    branch = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 500,
    }).trim().replace(/[\x00-\x1f\x7f]/g, " ");
  } catch { /* Not in a Git worktree, or Git is unavailable. */ }
  branchCache.set(cwd, { checkedAt: Date.now(), branch });
  return branch;
}

// --- Progress bar ---

function buildProgressBar(usage: any): { bar: string; details: string } {
  const segments = 16;
  const percent = usage?.percent ?? 0;
  const filled = Math.round((Math.max(0, Math.min(percent, 100)) / 100) * segments);
  const bar = "█".repeat(filled) + "░".repeat(segments - filled);
  return { bar, details: `${percent.toFixed(1)}% / ${formatTokens(usage?.contextWindow ?? 0)}` };
}

// --- Info panel ---

function buildInfoLines(width: number, infoWidth: number, ctxRef: any, pi: any, theme: any): string[] {
  if (!ctxRef) return [];

  const model = ctxRef.model;
  const thinkingLevel = (ctxRef.thinkingLevel ?? pi.getThinkingLevel?.() ?? "default").toLowerCase();
  const aliases = providerAliases();
  const provider = (model?.provider ?? "").toLowerCase();
  const modelId = (model?.id ?? "").replace(/[\x00-\x1f\x7f]/g, " ").toLowerCase();
  const modelLine = [aliases[provider] ?? provider, modelId, thinkingLevel].filter(Boolean).join(" • ");

  const context = ctxRef.getContextUsage?.();
  let entries: any[] = [];
  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  try {
    entries = ctxRef.sessionManager.getEntries() ?? [];
    totals = sessionUsage(entries);
  } catch { /* session entries may be unavailable */ }

  const progress = buildProgressBar(context);
  const statsParts = [
    "✨", `↑${formatTokens(totals.input)}`, `↓${formatTokens(totals.output)}`,
  ];
  statsParts.push("♻️", `${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
  // Hide cost when the model has no pricing (e.g. subscription bridges report zero).
  if (totals.cost > 0) statsParts.push("💰", `$${totals.cost.toFixed(3)}`);
  const statsLine = statsParts.join(" ");
  const cwd = ctxRef.sessionManager.getCwd?.() ?? process.cwd();
  const branch = getGitBranch(cwd);
  const sessionName = (ctxRef.sessionManager.getSessionName?.() ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ").trim() || "π";
  const gold = theme.getColorMode() === "truecolor"
    ? "\x1b[38;2;181;158;101m"
    : "\x1b[38;5;143m";
  const dirText = compactDirectory(cwd);

  // Layout: left column = session (gold) / model / dir / branch; right column =
  // progress / tokens / time·turns. Right content is right-aligned per row.
  const startMs = cachedSessionStartMs(entries);
  const elapsed = formatElapsed(Math.max(0, Date.now() - startMs));
  const turns = countTurns(entries);
  const timeTurnsLine = `⏱️ ${elapsed} · 🔄 ${turns}`;

  const progressLine = `${theme.fg("text", `▕${progress.bar}▏`)}${theme.fg("dim", ` ${progress.details}`)}`;

  const leftLines = [
    `${gold}${sessionName}\x1b[39m`,
    theme.fg("dim", `🤖 ${modelLine}`),
    theme.fg("dim", `📁 ${dirText}`),
    branch ? theme.fg("dim", `🌿 ${branch}`) : "",
  ];
  const rightLines = [progressLine, statsLine, timeTurnsLine];

  const composed: string[] = [];
  for (let i = 0; i < leftLines.length; i++) {
    const leftRaw = leftLines[i];
    let left = leftRaw;
    let leftW = visibleWidth(left);
    if (leftW > infoWidth) {
      left = i === 0
        ? `${gold}${truncateToWidth(sessionName, infoWidth, "…")}\x1b[39m`
        : theme.fg("dim", truncateToWidth(leftRaw, infoWidth, "…"));
      leftW = visibleWidth(left);
    }
    const rightRaw = rightLines[i] ?? "";
    let rightW = visibleWidth(rightRaw);
    let right = rightRaw;
    if (rightW > 0) {
      if (leftW + rightW + 2 > infoWidth) {
        const budget = infoWidth - leftW - 2;
        if (budget <= 0) {
          right = "";
          rightW = 0;
        } else {
          right = theme.fg("dim", truncateToWidth(rightRaw, budget, "…"));
          rightW = visibleWidth(right);
        }
      } else {
        right = theme.fg("dim", rightRaw);
        rightW = visibleWidth(right);
      }
    }
    composed.push(rightW > 0
      ? `${left}${" ".repeat(Math.max(2, infoWidth - leftW - rightW))}${right}`
      : left);
  }
  return composed;
}

// --- Render helpers ---

/**
 * Kitty image layout: image sequence on row 0 (zero-width, cursor doesn't move),
 * avatarPad fills the space. Info text beside the image on all rows.
 */
function renderKittyFrame(frame: RenderedFrame & { kind: "image" }, _width: number, config: Config, infoLines: string[], separatorColor: (s: string) => string): string[] {
  const sep = separatorColor("│");
  const leftMargin = " ";
  const avatarPad = " ".repeat(config.size);
  const avatarSkip = `\x1b[${config.size}C`;
  const useSkip = frame.padMode === "skip";
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    if (i === 0) {
      const pad = useSkip ? avatarSkip : avatarPad;
      lines.push(leftMargin + frame.sequence + `${pad} ${sep} ${infoLines[i] ?? ""}`);
    } else {
      lines.push(`${leftMargin}${avatarPad} ${sep} ${infoLines[i] ?? ""}`);
    }
  }

  return lines;
}

/**
 * iTerm2 image layout — text first, image last.
 *
 * The TUI processes lines top-to-bottom, erasing each with \x1b[2K before
 * writing. By placing the image on the LAST widget row with cursor-up
 * positioning, the image is rendered AFTER all line clears. It extends
 * downward over rows that already have text, filling the image area
 * (cols 1–size) without being erased. Text in cols (size+1)+ is preserved.
 *
 * Layout: frame.rows total (frame.rows-1 text rows + 1 image row).
 */
function renderITermFrame(frame: RenderedFrame & { kind: "image" }, _width: number, config: Config, infoLines: string[], separatorColor: (s: string) => string): string[] {
  const sep = separatorColor("│");
  const size = config.size;
  const skipPad = `\x1b[${1 + size}C`;
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    if (i < frame.rows - 1) {
      // Text rows: cursor-right past image area, then info
      lines.push(`${skipPad} ${sep} ${infoLines[i] ?? ""}`);
    } else {
      // Last row: cursor-up to first text row, place image, then text
      // After the image, cursor returns to this row (last image row, col 0).
      const up = frame.rows > 1 ? `\x1b[${frame.rows - 1}A` : "";
      lines.push(`${up}\x1b[1C${frame.sequence} ${sep} ${infoLines[i] ?? ""}`);
    }
  }

  return lines;
}

const TEXT_CANVAS_COLS = 8;
const TEXT_CANVAS_ROWS = 4;

function renderTextFrame(frame: RenderedFrame & { kind: "text" }, _width: number, _config: Config, infoLines: string[], separatorColor: (s: string) => string): string[] {
  const sep = separatorColor("│");
  const leftMargin = " ";
  const avatarPad = " ".repeat(TEXT_CANVAS_COLS);

  // Fixed 8×4 canvas, vertically center the frame lines.
  const emoteLines = frame.lines;
  const rowCount = Math.max(TEXT_CANVAS_ROWS, infoLines.length);
  const emoteStart = Math.floor((rowCount - emoteLines.length) / 2);
  const lines: string[] = [];

  for (let i = 0; i < rowCount; i++) {
    const emoteIdx = i - emoteStart;
    const emote = (emoteIdx >= 0 && emoteIdx < emoteLines.length) ? emoteLines[emoteIdx] : "";
    const emoteWidth = visibleWidth(emote);
    // Warn if a line exceeds the canvas width
    if (emoteWidth > TEXT_CANVAS_COLS) {
      log(`AsciiRenderer: line ${emoteIdx} exceeds ${TEXT_CANVAS_COLS} cols (${emoteWidth})`);
    }
    // Center within canvas
    const totalPad = TEXT_CANVAS_COLS - emoteWidth;
    const padLeft = totalPad > 0 ? " ".repeat(Math.floor(totalPad / 2)) : "";
    const padRight = totalPad > 0 ? " ".repeat(Math.ceil(totalPad / 2)) : "";
    const cell = emote ? `${padLeft}${emote}${padRight}` : avatarPad;
    lines.push(`${leftMargin}${cell} ${sep} ${infoLines[i] ?? ""}`);
  }

  return lines;
}

/**
 * Unicode placeholder layout: placeholder text lines fill rows 0–N.
 * Each line is already config.size wide (placeholder chars). Info beside it.
 */
function renderPlaceholderFrame(frame: RenderedFrame & { kind: "placeholder" }, _width: number, _config: Config, infoLines: string[], separatorColor: (s: string) => string): string[] {
  const sep = separatorColor("│");
  const leftMargin = " ";
  const lines: string[] = [];

  for (let i = 0; i < frame.rows; i++) {
    lines.push(`${leftMargin}${frame.lines[i] ?? ""} ${sep} ${infoLines[i] ?? ""}`);
  }

  return lines;
}

// --- Widget factory ---

export interface WidgetDeps {
  animator: Animator;
  config: Config;
  pi: any;
  getCtxRef: () => any;
  getCurrentEmoteSet: () => string;
  getEmoteVisible: () => boolean;
  tuiRef: { current: any };
}

/**
 * True when a modal dialog owns the UI (e.g. ask_user_question, /model picker,
 * MCP approval). Dialogs replace the editor and move focus to a non-editor
 * component; the editor (and custom editors) expose getText().
 */
function isDialogActive(tui: any): boolean {
  try {
    if (!tui || typeof tui.getFocusedComponent !== "function") return false;
    const focused = tui.getFocusedComponent();
    if (!focused) return false;
    return typeof focused.getText !== "function";
  } catch {
    return false;
  }
}

export function createWidgetFactory(deps: WidgetDeps) {
  return (tui: any, theme: any) => {
    deps.animator.setTui(tui);
    deps.tuiRef.current = tui;
    return {
      render(width: number): string[] {
        const { animator, config } = deps;

        if (width < config.hideBelow) return [];
        if (isDialogActive(tui)) return [];

        const frame = animator.getRenderedFrame();
        if (!frame) {
          log(`render: no frame`);
          return [];
        }

        log(`render: kind=${frame.kind}, set="${deps.getCurrentEmoteSet()}"`);

        const dim = (text: string) => theme.fg("dim", text);
        const separatorColor = dim;
        const border = dim("─".repeat(width));
        const showEmote = deps.getEmoteVisible();
        const avatarWidth = frame.kind === "text" ? TEXT_CANVAS_COLS : config.size;
        const infoWidth = showEmote ? width - avatarWidth - 5 : width - 2;
        const infoLines = buildInfoLines(width, infoWidth, deps.getCtxRef(), deps.pi, theme);

        const lines: string[] = [];
        lines.push(border);

        if (!showEmote) {
          // Avatar and separator hidden — info panel takes the full width.
          for (const line of infoLines) lines.push(` ${line}`);
          lines.push("");
          return lines;
        }

        if (frame.kind === "image") {
          if (frame.cursorAdvances) {
            lines.push(...renderITermFrame(frame, width, config, infoLines, separatorColor));
          } else {
            lines.push(...renderKittyFrame(frame, width, config, infoLines, separatorColor));
          }
        } else if (frame.kind === "placeholder") {
          lines.push(...renderPlaceholderFrame(frame, width, config, infoLines, separatorColor));
        } else {
          lines.push(...renderTextFrame(frame, width, config, infoLines, separatorColor));
        }

        lines.push("");

        return lines;
      },
      invalidate() {},
      dispose() {
        deps.animator.setTui(null);
      },
    };
  };
}
