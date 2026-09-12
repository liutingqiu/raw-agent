/**
 * The look: startup card, status bar, tool rendering, and the animations.
 *
 * Layout is drawn bottom-up so the input block can be redrawn in place:
 *
 *     ╭─ card ─────────────╮        (startup only, scrolls away)
 *     status bar                     animated
 *     hint line
 *     prompt / input
 *     completion menu                (drawn above the input)
 */
import { clip, displayWidth, out, pad, screen } from "./term.ts";
import { bold, dim, glyph, gradient, keyLabel, paint, theme } from "./theme.ts";

/* ------------------------------------------------------------------ *
 * primitives
 * ------------------------------------------------------------------ */

/** a bordered box that respects display width */
export function box(lines: string[], width: number, opts: { title?: string; color?: string } = {}): string[] {
  const color = opts.color ?? theme.accentDim;
  const inner = Math.max(8, width - 4);
  const title = opts.title ? ` ${opts.title} ` : "";
  const head = glyph.tl + glyph.h.repeat(Math.max(0, width - 2 - displayWidth(title))) + title + glyph.tr;
  const rows = [paint(head, color)];
  for (const line of lines) {
    rows.push(paint(glyph.v, color) + " " + pad(clip(line, inner), inner) + " " + paint(glyph.v, color));
  }
  rows.push(paint(glyph.bl + glyph.h.repeat(Math.max(0, width - 2)) + glyph.br, color));
  return rows;
}

/** a horizontal rule with an optional inline label */
export function rule(width: number, label = ""): string {
  if (!label) return paint(glyph.h.repeat(Math.max(0, width)), theme.faint);
  const text = ` ${label} `;
  const rest = Math.max(0, width - displayWidth(text) - 2);
  return paint(glyph.h.repeat(2) + text + glyph.h.repeat(rest), theme.faint);
}

/** gradient usage meter */
export function meter(used: number, total: number, width = 12): string {
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const filled = Math.round(ratio * width);
  const color = ratio > 0.85 ? theme.err : ratio > 0.6 ? theme.warn : theme.ok;
  return paint(glyph.meterFull.repeat(filled), color) + paint(glyph.meterEmpty.repeat(Math.max(0, width - filled)), theme.faint);
}

export function humanTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/* ------------------------------------------------------------------ *
 * the input block: redrawn in place on every keystroke
 * ------------------------------------------------------------------ */

export class Block {
  private drawn = 0;
  private cursorRow = 0;
  private cursorCol = -1;
  private lastFrame = "";

  /** replace the whole block in place; `cursorRow` is where the text cursor goes */
  render(lines: string[], cursorRow: number, cursorCol: number) {
    if (!lines.length) return;
    const frame = lines.join("\n");

    // identical frame and the cursor is already in place: write nothing at all,
    // which is what keeps an idle prompt from flickering
    if (frame === this.lastFrame && this.drawn === lines.length) {
      this.moveCursorTo(cursorRow, cursorCol);
      return;
    }

    this.erase();
    out(frame);
    this.drawn = lines.length;
    this.lastFrame = frame;
    this.cursorRow = lines.length - 1; // writing leaves the cursor on the last row
    this.moveCursorTo(cursorRow, cursorCol);
  }

  private moveCursorTo(row: number, col: number) {
    const target = Math.max(0, Math.min(row, Math.max(0, this.drawn - 1)));
    const delta = target - this.cursorRow;
    if (delta > 0) screen.down(delta);
    else if (delta < 0) screen.up(-delta);
    this.cursorRow = target;
    if (this.cursorCol !== col) {
      screen.moveTo(col + 1);
      this.cursorCol = col;
    }
  }

  /**
   * Wipe exactly the rows this block occupies. Clearing "to end of screen"
   * was wrong: once the terminal scrolled, it erased the wrong region and left
   * orphaned prompt lines behind.
   */
  erase() {
    if (this.drawn <= 0) return;
    if (this.cursorRow > 0) screen.up(this.cursorRow);
    for (let i = 0; i < this.drawn; i++) {
      screen.clearLine();
      if (i < this.drawn - 1) screen.down(1);
    }
    if (this.drawn > 1) screen.up(this.drawn - 1);
    screen.moveTo(1);
    this.drawn = 0;
    this.cursorRow = 0;
    this.cursorCol = -1;
    this.lastFrame = "";
  }

  get height() {
    return this.drawn;
  }
}

/* ------------------------------------------------------------------ *
 * spinner / animations
 * ------------------------------------------------------------------ */

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private started = 0;
  private label = "";
  private live = false;

  start(label: string) {
    this.label = label;
    this.started = Date.now();
    this.frame = 0;
    if (this.live) return;
    this.live = true;
    screen.hideCursor();
    this.timer = setInterval(() => this.draw(), 90);
    this.draw();
  }

  setLabel(label: string) {
    this.label = label;
  }

  private draw() {
    const spin = glyph.spark[this.frame++ % glyph.spark.length];
    const secs = (Date.now() - this.started) / 1000;
    const time = secs > 1 ? dim(` ${secs.toFixed(0)}s`) : "";
    screen.clearLine();
    out(`${paint(spin, theme.accent)} ${this.label}${time}`);
  }

  /** stop and clear the animated line */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.live) {
      screen.clearLine();
      screen.showCursor();
      this.live = false;
    }
  }
}

/** a short animated reveal, used once at startup */
export async function animateWordmark(text: string, frames = 14, delay = 26) {
  for (let f = 0; f < frames; f++) {
    screen.clearLine();
    out(gradient(text, [122, 162, 247], [187, 154, 247], f * 1.6));
    await new Promise((r) => setTimeout(r, delay));
  }
  screen.clearLine();
  out(gradient(text, [122, 162, 247], [187, 154, 247], frames));
}

/* ------------------------------------------------------------------ *
 * cards
 * ------------------------------------------------------------------ */

export type StartupInfo = {
  version: string;
  provider: string;
  model: string;
  effort: string;
  permission: string;
  workspace: string;
  proxy?: string | null;
  toolCount: number;
  configured: boolean;
};

export function startupLines(info: StartupInfo, width: number): string[] {
  const label = (s: string) => paint(s.padEnd(10), theme.muted);
  const rows: string[] = [];

  rows.push(`${paint("raw", bold, theme.brand)} ${dim(`v${info.version}`)}   ${dim(info.configured ? "ready" : "no model configured — run `raw setup`")}`);
  rows.push("");
  rows.push(`${label("model")}${paint(info.provider, theme.accent)}${dim("/")}${paint(info.model, theme.accent)}  ${dim(`${info.effort} effort`)}`);
  rows.push(`${label("workspace")}${dim(clip(info.workspace, Math.max(10, width - 16)))}`);
  rows.push(`${label("mode")}${paint(info.permission, theme.warn)}  ${dim(`${info.toolCount} tools`)}${info.proxy ? dim(`  proxy ${info.proxy}`) : ""}`);
  rows.push("");
  rows.push(dim(`${keyLabel("commands")} commands   ${keyLabel("files")} files   ${keyLabel("paste-image")} paste image   ? help`));

  return box(rows, width, { title: "raw" });
}

/* ------------------------------------------------------------------ *
 * status bar
 * ------------------------------------------------------------------ */

export type StatusState = {
  provider: string;
  model: string;
  effort: string;
  permission: string;
  used: number;
  total: number;
  streaming: boolean;
  turns: number;
};

export function statusLine(s: StatusState, width: number): string {
  // only the busy state animates; an idle status bar never repaints, so it can't flicker
  const pulse = s.streaming ? glyph.pulse[Math.floor(Date.now() / 200) % glyph.pulse.length] : glyph.bullet;
  const dot = paint(pulse, s.streaming ? theme.accent : theme.faint);

  const left = `${dot} ${paint(s.model, theme.accentDim)}${s.effort ? dim(` ${s.effort}`) : ""}`;
  const mode = s.permission === "auto" ? theme.ok : s.permission === "ask" ? theme.warn : theme.info;
  const modeText = paint(s.permission, mode);
  const meterText = `${meter(s.used, s.total, 10)} ${dim(`${humanTokens(s.used)}/${humanTokens(s.total)}`)}`;
  const right = `${modeText}  ${meterText}`;

  const gap = Math.max(1, width - displayWidth(left) - displayWidth(right));
  const line = left + " ".repeat(gap) + right;
  return displayWidth(line) < width ? line + " ".repeat(width - displayWidth(line)) : clip(line, width);
}

/* ------------------------------------------------------------------ *
 * tool + result rendering
 * ------------------------------------------------------------------ */

export function toolCallLine(name: string, preview: string, width: number): string {
  return clip(`${paint(glyph.arrow, theme.brand)} ${paint(name, bold)} ${dim(preview)}`, width);
}

export function toolResultLine(text: string, ms: number, ok: boolean, width: number): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "(no output)";
  const time = ms > 400 ? dim(` ${(ms / 1000).toFixed(1)}s`) : "";
  const body = ok ? dim(first) : paint(first, theme.err);
  return clip(`  ${paint(glyph.branch, theme.faint)} ${body}${time}`, width);
}

export function sectionTitle(text: string): string {
  return paint(text, bold, theme.info);
}

export function bullet(text: string, width: number): string {
  return clip(`${paint(glyph.bullet, theme.faint)} ${text}`, width);
}
