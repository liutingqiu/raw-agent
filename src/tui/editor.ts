/**
 * Line editor as a pure state machine: keys in, text + cursor out.
 *
 * Everything a terminal needs (wrapping, cursor placement, the completion menu)
 * is computed here so it can be unit tested without a tty.
 */
import type { Key } from "./term.ts";
import { displayWidth } from "./term.ts";
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

  insert(text: string) {
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
    const line = this.line();
    this.lines.splice(this.row, 1, line.slice(0, this.col), line.slice(this.col));
    this.row++;
    this.col = 0;
    this.menu = [];
    this.menuKind = null;
  }

  backspace() {
    if (this.col > 0) {
      const line = this.line();
      this.setLine(line.slice(0, this.col - 1) + line.slice(this.col));
      this.col--;
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1];
      const merged = prev + this.line();
      this.lines.splice(this.row - 1, 2, merged);
      this.row--;
      this.col = prev.length;
    }
    this.refreshMenu();
  }

  deleteForward() {
    const line = this.line();
    if (this.col < line.length) {
      this.setLine(line.slice(0, this.col) + line.slice(this.col + 1));
    } else if (this.row < this.lines.length - 1) {
      this.setLine(line + this.lines[this.row + 1]);
      this.lines.splice(this.row + 1, 1);
    }
    this.refreshMenu();
  }

  killWord() {
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
    this.setLine(this.line().slice(this.col));
    this.col = 0;
    this.refreshMenu();
  }

  private moveWord(delta: number) {
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

  private cursorUp() {
    if (this.menu.length) {
      this.menuIndex = (this.menuIndex - 1 + this.menu.length) % this.menu.length;
      return;
    }
    if (this.row > 0) {
      this.row--;
      this.col = Math.min(this.col, this.line().length);
    } else {
      this.historyStep(-1);
    }
  }

  private cursorDown() {
    if (this.menu.length) {
      this.menuIndex = (this.menuIndex + 1) % this.menu.length;
      return;
    }
    if (this.row < this.lines.length - 1) {
      this.row++;
      this.col = Math.min(this.col, this.line().length);
    } else {
      this.historyStep(1);
    }
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
  }

  /* ----------------------------- completion ----------------------------- */

  /** the token the cursor is currently inside, plus how it started */
  private currentToken(): { token: string; kind: "command" | "file" | null; start: number } {
    const line = this.line().slice(0, this.col);
    const at = line.lastIndexOf("@");
    const slash = line.match(/(?:^|\s)\/([\w-]*)$/);
    if (slash) {
      const start = line.length - slash[1].length - 1;
      return { token: slash[1], kind: "command", start };
    }
    if (at >= 0 && !/\s/.test(line.slice(at + 1))) {
      return { token: line.slice(at + 1), kind: "file", start: at };
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
  acceptCompletion(): boolean {
    if (!this.menu.length) return false;
    const { kind, start } = this.currentToken();
    const value = this.menu[this.menuIndex].value;
    const line = this.line();
    const end = kind === "file" ? this.col : line.length;
    const insert = kind === "command" ? value + " " : value;
    this.setLine(line.slice(0, start) + insert + line.slice(end));
    this.col = start + insert.length;
    this.menu = [];
    this.menuKind = null;
    return true;
  }

  /* -------------------------------- keys -------------------------------- */

  handle(key: Key): EditorAction {
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
        if (key.ctrl || key.alt) this.moveWord(-1);
        else if (this.col > 0) this.col--;
        else if (this.row > 0) {
          this.row--;
          this.col = this.line().length;
        }
        return null;
      case "right":
        if (key.ctrl || key.alt) this.moveWord(1);
        else if (this.col < this.line().length) this.col++;
        else if (this.row < this.lines.length - 1) {
          this.row++;
          this.col = 0;
        }
        return null;
      case "up":
        this.cursorUp();
        return null;
      case "down":
        this.cursorDown();
        return null;
      case "home":
        this.col = 0;
        return null;
      case "end":
        this.col = this.line().length;
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
        this.col = 0;
        return null;
      case "e":
        this.col = this.line().length;
        return null;
      case "u":
        this.killLine();
        return null;
      case "w":
        this.killWord();
        return null;
      case "k":
        this.setLine(this.line().slice(0, this.col));
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
    let cursorRow = 0;
    let cursorCol = 0;

    this.lines.forEach((line, li) => {
      const prefix = li === 0 ? prompt : continuation;
      const avail = Math.max(4, width - displayWidth(prefix));
      const chars = [...line];

      // wrap into chunks, remembering where the cursor's chunk is
      const chunks: { text: string; start: number; end: number }[] = [];
      let start = 0;
      let w = 0;
      let buf = "";
      chars.forEach((ch, idx) => {
        const cw = displayWidth(ch);
        if (w + cw > avail && buf.length) {
          chunks.push({ text: buf, start, end: idx });
          start = idx;
          buf = "";
          w = 0;
        }
        buf += ch;
        w += cw;
      });
      chunks.push({ text: buf, start, end: chars.length });

      chunks.forEach((chunk, ci) => {
        const rowIndex = rows.length;
        rows.push((ci === 0 ? prefix : continuation) + chunk.text);
        // where is the cursor inside this chunk?
        if (li === this.row && this.col >= chunk.start && (this.col < chunk.end || (ci === chunks.length - 1 && this.col <= chunk.end))) {
          const before = chars.slice(chunk.start, Math.min(this.col, chunk.end)).join("");
          cursorRow = rowIndex;
          cursorCol = displayWidth(ci === 0 ? prefix : continuation) + displayWidth(before);
        }
      });
      // a cursor at the very end of a fully-filled last line
      if (li === this.row && this.col === chars.length && chars.length === 0) {
        cursorRow = rows.length - 1;
        cursorCol = displayWidth(prefix);
      }
    });

    return { rows, cursorRow, cursorCol };
  }

  /** the highlighted completion, for the caller to draw */
  menuView(max = 8): { label: string; hint?: string; selected: boolean }[] {
    const slice = this.menu.slice(0, max);
    return slice.map((c, i) => ({ label: c.value, hint: c.hint, selected: i === this.menuIndex }));
  }

  attachmentChips(): string[] {
    return this.attachmentLabels.map((l, i) => `[${i + 1}] ${l}`);
  }
}

export const attachmentIcon = glyph.bullet;
