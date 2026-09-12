/**
 * Line editor as a pure state machine: keys in, text + cursor out.
 *
 * Everything a terminal needs (wrapping, cursor placement, the completion menu)
 * is computed here so it can be unit tested without a tty.
 */
import type { Key } from "./term.ts";
import { displayWidth, graphemes } from "./term.ts";
import { glyph } from "./theme.ts";
import type { ImagePart } from "../tools.ts";

export type EditorAction =
  | { type: "submit"; text: string }
  | { type: "interrupt" }
  | { type: "exit" }
  | { type: "permission-cycle" }
  | { type: "expand" }
  | { type: "paste-image" }
  | { type: "menu" }
  | null;

export type Completion = { value: string; hint?: string };
type VisualRow = { line: number; start: number; end: number; prefixWidth: number; last: boolean };

const WORD = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD.test(ch);
}

export class Editor {
  lines: string[] = [""];
  row = 0;
  col = 0;

  /** images attached to the next message */
  attachments: ImagePart[] = [];
  attachmentLabels: string[] = [];

  history: string[] = [];
  private historyIndex = -1;
  private draft = "";
  private visualRows: VisualRow[] = [];
  private verticalColumn: number | null = null;

  /** completion menu */
  menu: Completion[] = [];
  menuIndex = 0;
  menuKind: "command" | "file" | null = null;
  completer: ((token: string, kind: "command" | "file") => Completion[]) | null = null;

  /* ----------------------------- accessors ----------------------------- */

  text(): string {
    return this.lines.join("\n");
  }

  isEmpty(): boolean {
    return this.text().trim().length === 0 && this.attachments.length === 0;
  }

  setText(text: string, { append = false } = {}) {
    if (append && this.text().length) text = this.text() + "\n" + text;
    this.lines = text.split("\n");
    if (!this.lines.length) this.lines = [""];
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.verticalColumn = null;
    this.refreshMenu();
  }

  clear() {
    this.lines = [""];
    this.row = 0;
    this.col = 0;
    this.attachments = [];
    this.attachmentLabels = [];
    this.historyIndex = -1;
    this.draft = "";
    this.menu = [];
    this.menuKind = null;
    this.visualRows = [];
    this.verticalColumn = null;
  }

  attach(image: ImagePart, label: string) {
    this.attachments.push(image);
    this.attachmentLabels.push(label);
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
    this.attachmentLabels.splice(index, 1);
  }

  /* ------------------------------- editing ------------------------------- */

  private line(): string {
    return this.lines[this.row];
  }

  private setLine(s: string) {
    this.lines[this.row] = s;
  }

  private resetVertical() {
    this.verticalColumn = null;
  }

  insert(text: string) {
    this.resetVertical();
    if (!text.includes("\n")) {
      const line = this.line();
      this.setLine(line.slice(0, this.col) + text + line.slice(this.col));
      this.col += text.length;
      this.refreshMenu();
      return;
    }
    // pasted text may span lines: splice the new rows in at the cursor
    const before = this.line().slice(0, this.col);
    const after = this.line().slice(this.col);
    const parts = text.split("\n");
    parts[0] = before + parts[0];
    parts[parts.length - 1] = parts[parts.length - 1] + after;
    this.lines.splice(this.row, 1, ...parts);
    this.row += parts.length - 1;
    this.col = parts[parts.length - 1].length - after.length;
    this.refreshMenu();
  }

  private newline() {
    this.resetVertical();
    const line = this.line();
    this.lines.splice(this.row, 1, line.slice(0, this.col), line.slice(this.col));
    this.row++;
    this.col = 0;
    this.menu = [];
    this.menuKind = null;
  }

  backspace() {
    this.resetVertical();
    if (this.col > 0) {
      const line = this.line();
      const previous = graphemes(line).findLast((part) => part.end <= this.col)?.start ?? 0;
      this.setLine(line.slice(0, previous) + line.slice(this.col));
      this.col = previous;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      const merged = prev + this.line();
      this.lines.splice(this.row - 1, 2, merged);
      this.row--;
      this.col = prev.length;
    } else if (!this.line().length && this.attachments.length) {
      this.removeAttachment(this.attachments.length - 1);
    }
    this.refreshMenu();
  }

  deleteForward() {
    this.resetVertical();
    const line = this.line();
    if (this.col < line.length) {
      const next = graphemes(line).find((part) => part.start >= this.col)?.end ?? line.length;
      this.setLine(line.slice(0, this.col) + line.slice(next));
    } else if (this.row < this.lines.length - 1) {
      this.setLine(line + this.lines[this.row + 1]);
      this.lines.splice(this.row + 1, 1);
    }
    this.refreshMenu();
  }

  killWord() {
    this.resetVertical();
    const line = this.line();
    if (this.col === 0) {
      this.backspace();
      return;
    }
    let i = this.col;
    while (i > 0 && !isWordChar(line[i - 1])) i--;
    while (i > 0 && isWordChar(line[i - 1])) i--;
    this.setLine(line.slice(0, i) + line.slice(this.col));
    this.col = i;
    this.refreshMenu();
  }

  killLine() {
    this.resetVertical();
    this.setLine(this.line().slice(this.col));
    this.col = 0;
    this.refreshMenu();
  }

  private moveWord(delta: number) {
    this.resetVertical();
    const line = this.line();
    let i = this.col;
    if (delta < 0) {
      while (i > 0 && !isWordChar(line[i - 1])) i--;
      while (i > 0 && isWordChar(line[i - 1])) i--;
    } else {
      while (i < line.length && !isWordChar(line[i])) i++;
      while (i < line.length && isWordChar(line[i])) i++;
    }
    this.col = i;
  }

  private moveVisual(delta: -1 | 1): boolean {
    if (!this.visualRows.length) return false;
    const currentIndex = this.visualRows.findIndex((part) =>
      part.line === this.row && this.col >= part.start && (this.col < part.end || (part.last && this.col <= part.end))
    );
    if (currentIndex < 0) return false;
    const target = this.visualRows[currentIndex + delta];
    if (!target) return false;

    const current = this.visualRows[currentIndex];
    const currentColumn = current.prefixWidth + displayWidth(this.lines[this.row].slice(current.start, this.col));
    const wanted = this.verticalColumn ?? currentColumn;
    this.verticalColumn = wanted;

    const available = Math.max(0, wanted - target.prefixWidth);
    const segment = this.lines[target.line].slice(target.start, target.end);
    let width = 0;
    let offset = 0;
    const parts = graphemes(segment);
    for (const part of parts) {
      const next = width + displayWidth(part.text);
      if (next > available) break;
      width = next;
      offset = part.end;
    }
    // A boundary at the end of a wrapped row is rendered at the start of the
    // following row. Keep the cursor visibly on the requested target row.
    if (!target.last && offset === segment.length && parts.length) offset = parts.at(-1)!.start;
    this.row = target.line;
    this.col = target.start + offset;
    this.refreshMenu();
    return true;
  }

  private cursorUp() {
    if (this.menu.length) {
      this.menuIndex = (this.menuIndex - 1 + this.menu.length) % this.menu.length;
      return;
    }
    if (!this.visualRows.length && this.row > 0) {
      this.row--;
      this.col = Math.min(this.col, this.line().length);
      return;
    }
    if (!this.moveVisual(-1)) this.historyStep(-1);
  }

  private cursorDown() {
    if (this.menu.length) {
      this.menuIndex = (this.menuIndex + 1) % this.menu.length;
      return;
    }
    if (!this.visualRows.length && this.row < this.lines.length - 1) {
      this.row++;
      this.col = Math.min(this.col, this.line().length);
      return;
    }
    if (!this.moveVisual(1)) this.historyStep(1);
  }

  /* ------------------------------- history ------------------------------- */

  private historyStep(delta: number) {
    if (!this.history.length) return;
    if (this.historyIndex === -1 && delta < 0) {
      this.draft = this.text();
      this.historyIndex = this.history.length;
    }
    if (this.historyIndex === -1) return;
    const next = this.historyIndex + delta;
    if (next < 0) return;
    if (next >= this.history.length) {
      this.historyIndex = -1;
      this.replaceText(this.draft);
      return;
    }
    this.historyIndex = next;
    this.replaceText(this.history[next]);
  }

  remember(text: string) {
    if (!text.trim()) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 500) this.history.shift();
    this.historyIndex = -1;
  }

  private replaceText(text: string) {
    this.lines = text.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row].length;
    this.verticalColumn = null;
  }

  /* ----------------------------- completion ----------------------------- */

  /** the token the cursor is currently inside, plus how it started */
  private currentToken(): { token: string; kind: "command" | "file" | null; start: number } {
    const line = this.line().slice(0, this.col);
    const slash = line.match(/(?:^|\s)\/([\w-]*)$/);
    if (slash) {
      const start = line.length - slash[1].length - 1;
      return { token: slash[1], kind: "command", start };
    }
    const file = /(?:^|\s)@(?:"([^"]*)"?|([^\s]*))$/.exec(line);
    if (file) {
      const start = line.lastIndexOf("@");
      return { token: file[1] ?? file[2] ?? "", kind: "file", start };
    }
    return { token: "", kind: null, start: this.col };
  }

  refreshMenu() {
    if (!this.completer) return;
    const { token, kind } = this.currentToken();
    if (!kind) {
      this.menu = [];
      this.menuKind = null;
      return;
    }
    if (kind === "command" && !token.length && !this.line().slice(0, this.col).match(/(?:^|\s)\/$/)) {
      this.menu = [];
      this.menuKind = null;
      return;
    }
    const items = this.completer(token, kind);
    this.menu = items;
    this.menuKind = kind;
    if (this.menuIndex >= items.length) this.menuIndex = 0;
  }

  /** replace the current token with the highlighted completion */
  acceptCompletion(appendCommandSpace = true): boolean {
    if (!this.menu.length) return false;
    const { kind, start } = this.currentToken();
    const value = this.menu[this.menuIndex].value;
    const line = this.line();
    const end = this.col;
    const insert = kind === "command" && appendCommandSpace ? value + " " : value;
    this.setLine(line.slice(0, start) + insert + line.slice(end));
    this.col = start + insert.length;
    this.resetVertical();
    this.menu = [];
    this.menuKind = null;
    return true;
  }

  /* -------------------------------- keys -------------------------------- */

  handle(key: Key): EditorAction {
    if (key.id === "shift+tab") return { type: "permission-cycle" };
    if (key.id === "shift+enter" || key.id === "alt+enter") {
      this.newline();
      return null;
    }
    if (key.id === "alt+backspace" || key.id === "ctrl+backspace") {
      this.killWord();
      return null;
    }

    // Enter executes the highlighted slash command immediately. Tab only
    // completes it, leaving the cursor ready for arguments.
    if (this.menu.length && key.id === "enter" && this.menuKind === "command") {
      this.acceptCompletion(false);
      return this.submit();
    }

    // A menu key first: Enter accepts rather than submits.
    if (this.menu.length && (key.id === "enter" || key.name === "tab")) {
      this.acceptCompletion();
      return null;
    }
    if (this.menu.length && key.name === "escape") {
      this.menu = [];
      this.menuKind = null;
      return null;
    }

    switch (key.name) {
      case "enter":
        return this.submit();
      case "char":
        if (key.ctrl) return this.controlKey((key.text ?? "").toLowerCase());
        if (key.alt) return null;
        if (key.text === "j" && key.ctrl) return null;
        this.insert(key.text ?? "");
        return null;
      case "backspace":
        this.backspace();
        return null;
      case "delete":
        this.deleteForward();
        return null;
      case "left":
        this.resetVertical();
        if (key.ctrl || key.alt) this.moveWord(-1);
        else if (this.col > 0) this.col = graphemes(this.line()).findLast((part) => part.end <= this.col)?.start ?? 0;
        else if (this.row > 0) {
          this.row--;
          this.col = this.line().length;
        }
        this.refreshMenu();
        return null;
      case "right":
        this.resetVertical();
        if (key.ctrl || key.alt) this.moveWord(1);
        else if (this.col < this.line().length) this.col = graphemes(this.line()).find((part) => part.start >= this.col)?.end ?? this.line().length;
        else if (this.row < this.lines.length - 1) {
          this.row++;
          this.col = 0;
        }
        this.refreshMenu();
        return null;
      case "up":
        this.cursorUp();
        return null;
      case "down":
        this.cursorDown();
        return null;
      case "home":
        this.resetVertical();
        this.col = 0;
        this.refreshMenu();
        return null;
      case "end":
        this.resetVertical();
        this.col = this.line().length;
        this.refreshMenu();
        return null;
      case "tab":
        this.refreshMenu();
        if (!this.menu.length) this.insert("  ");
        return null;
      case "escape":
        return { type: "interrupt" };
      case "paste":
        this.insert((key.text ?? "").replace(/\r\n?/g, "\n"));
        return null;
      default:
        return null;
    }
  }

  private controlKey(letter: string): EditorAction {
    switch (letter) {
      case "c":
        if (this.isEmpty()) return { type: "interrupt" };
        this.clear();
        return null;
      case "d":
        if (this.isEmpty()) return { type: "exit" };
        this.deleteForward();
        return null;
      case "g":
        return { type: "paste-image" };
      case "j":
        this.newline();
        return null;
      case "o":
        return { type: "expand" };
      case "a":
        this.resetVertical();
        this.col = 0;
        this.refreshMenu();
        return null;
      case "e":
        this.resetVertical();
        this.col = this.line().length;
        this.refreshMenu();
        return null;
      case "u":
        this.killLine();
        return null;
      case "w":
        this.killWord();
        return null;
      case "k":
        this.setLine(this.line().slice(0, this.col));
        this.refreshMenu();
        return null;
      default:
        return null;
    }
  }

  private submit(): EditorAction {
    if (this.menu.length) {
      this.acceptCompletion();
      return null;
    }
    const text = this.text();
    if (!text.trim() && !this.attachments.length) return null;
    return { type: "submit", text };
  }

  /* ------------------------------ rendering ------------------------------ */

  /**
   * Lay the buffer out into display rows, wrapping at `width`, and report where
   * the cursor lands. `prompt` is drawn on the first row only.
   */
  render(width: number, prompt: string, continuation = "  "): { rows: string[]; cursorRow: number; cursorCol: number } {
    const rows: string[] = [];
    const visualRows: VisualRow[] = [];
    let cursorRow = 0;
    let cursorCol = 0;

    this.lines.forEach((line, li) => {
      const prefix = li === 0 ? prompt : continuation;
      const avail = Math.max(2, width - displayWidth(prefix));
      const chars = graphemes(line);

      // wrap into chunks, remembering where the cursor's chunk is
      const chunks: { text: string; start: number; end: number }[] = [];
      let start = 0;
      let w = 0;
      let buf = "";
      chars.forEach((part) => {
        const cw = displayWidth(part.text);
        if (w + cw > avail && buf.length) {
          chunks.push({ text: buf, start, end: part.start });
          start = part.start;
          buf = "";
          w = 0;
        }
        buf += part.text;
        w += cw;
      });
      chunks.push({ text: buf, start, end: line.length });

      chunks.forEach((chunk, ci) => {
        const rowIndex = rows.length;
        const rowPrefix = ci === 0 ? prefix : continuation;
        rows.push(rowPrefix + chunk.text);
        visualRows.push({
          line: li,
          start: chunk.start,
          end: chunk.end,
          prefixWidth: displayWidth(rowPrefix),
          last: ci === chunks.length - 1,
        });
        // where is the cursor inside this chunk?
        if (li === this.row && this.col >= chunk.start && (this.col < chunk.end || (ci === chunks.length - 1 && this.col <= chunk.end))) {
          const before = line.slice(chunk.start, Math.min(this.col, chunk.end));
          cursorRow = rowIndex;
          cursorCol = displayWidth(ci === 0 ? prefix : continuation) + displayWidth(before);
        }
      });
      // a cursor at the very end of a fully-filled last line
      if (li === this.row && this.col === line.length && line.length === 0) {
        cursorRow = rows.length - 1;
        cursorCol = displayWidth(prefix);
      }
    });

    this.visualRows = visualRows;
    return { rows, cursorRow, cursorCol };
  }

  /** the highlighted completion, for the caller to draw */
  menuView(max = 8): { label: string; hint?: string; selected: boolean }[] {
    const start = Math.max(0, Math.min(this.menuIndex - max + 1, Math.max(0, this.menu.length - max)));
    const slice = this.menu.slice(start, start + max);
    return slice.map((c, i) => ({ label: c.value, hint: c.hint, selected: start + i === this.menuIndex }));
  }

  attachmentChips(): string[] {
    return this.attachmentLabels.map((l, i) => `[${i + 1}] ${l}`);
  }
}

export const attachmentIcon = glyph.bullet;
