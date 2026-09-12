/**
 * Terminal layer: raw mode, a key parser, and screen primitives.
 *
 * The key parser is a pure function of (buffer) -> (keys, rest), so it can be
 * unit tested without a terminal.
 */
import { isTTY } from "./theme.ts";

export type KeyName =
  | "char"
  | "enter"
  | "tab"
  | "backspace"
  | "delete"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "f2"
  | "mouse"
  | "paste"
  | "resize"
  | "unknown";

export type Key = {
  name: KeyName;
  /** only set for name === "resize" (CSI 18 t reply) */
  cols?: number;
  rows?: number;
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "other";
  mouseAction?: "press" | "release" | "move";
  /** for name === "char" (may be a multi-byte character) or "paste" */
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  /** canonical id used by the keybinding table, e.g. "ctrl+c" */
  id: string;
};

const CSI_LETTERS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const CSI_TILDES: Record<string, KeyName> = {
  "1": "home",
  "2": "unknown", // insert
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

function make(name: KeyName, extra: Partial<Key> = {}): Key {
  const parts: string[] = [];
  if (extra.ctrl) parts.push("ctrl");
  if (extra.alt) parts.push("alt");
  if (extra.shift) parts.push("shift");
  const base = name === "char" ? (extra.text ?? "").toLowerCase() : name;
  parts.push(base);
  return { name, id: parts.join("+"), ...extra };
}

/**
 * Parse as many complete keys as possible out of `buf`.
 * Returns the keys and whatever trailing bytes are still incomplete.
 */
export function parseKeys(buf: string): { keys: Key[]; rest: string } {
  const keys: Key[] = [];
  let i = 0;

  const incomplete = (from: number) => ({ keys, rest: buf.slice(from) });

  while (i < buf.length) {
    const ch = buf[i];

    /* ------------------------------ escape ------------------------------ */
    if (ch === "\x1b") {
      const next = buf[i + 1];

      // lone ESC (no following bytes yet): the caller decides with a timeout
      if (next === undefined) return incomplete(i);

      // bracketed paste: ESC [ 200 ~ … ESC [ 201 ~
      if (buf.startsWith("\x1b[200~", i)) {
        const end = buf.indexOf("\x1b[201~", i + 6);
        if (end < 0) return incomplete(i);
        keys.push(make("paste", { text: buf.slice(i + 6, end) }));
        i = end + 6;
        continue;
      }

      // SGR mouse reporting: ESC [ < button ; column ; row M/m
      if (buf.startsWith("\x1b[<", i)) {
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf.slice(i));
        if (!mouse) return incomplete(i);
        const code = Number(mouse[1]);
        const base = code & 3;
        const button = (code & 64) !== 0
          ? (base === 0 ? "wheel-up" : "wheel-down")
          : base === 0 ? "left" : base === 1 ? "middle" : base === 2 ? "right" : "other";
        keys.push({
          name: "mouse",
          id: `mouse:${button}`,
          x: Number(mouse[2]),
          y: Number(mouse[3]),
          button,
          mouseAction: (code & 32) !== 0 ? "move" : mouse[4] === "m" ? "release" : "press",
        });
        i += mouse[0].length;
        continue;
      }

      if (next === "[") {
        // CSI: ESC [ params letter  /  ESC [ params ~
        let j = i + 2;
        while (j < buf.length && /[0-9;:<=>?]/.test(buf[j])) j++;
        if (j >= buf.length) return incomplete(i);
        const params = buf.slice(i + 2, j);
        const final = buf[j];
        i = j + 1;

        const bits = params.split(";").map((p) => Number(p.split(":")[0]));
        const modifier = bits.length > 1 ? bits[1] : undefined;
        // XTerm/kitty encode modifiers as 1 + a bitmask:
        // Shift=1, Alt=2, Ctrl=4. Testing the encoded number itself loses
        // combinations such as 4 (Shift+Alt) and 8 (all three modifiers).
        const modifierBits = modifier === undefined ? 0 : Math.max(0, modifier - 1);
        const mods = {
          shift: (modifierBits & 1) !== 0,
          alt: (modifierBits & 2) !== 0,
          ctrl: (modifierBits & 4) !== 0,
        };

        if (final === "~") {
          const name = bits[0] === 12 ? "f2" : (CSI_TILDES[String(bits[0])] ?? "unknown");
          keys.push(make(name, mods));
          continue;
        }
        if (final === "Z") {
          keys.push(make("tab", { shift: true }));
          continue;
        }
        if (final === "u") {
          // kitty keyboard protocol: ESC [ codepoint ; modifier u
          const code = bits[0] || 0;
          if (code === 13) keys.push(make("enter", mods));
          else if (code === 9) keys.push(make("tab", mods));
          else if (code === 127 || code === 8) keys.push(make("backspace", mods));
          else if (code === 27) keys.push(make("escape", mods));
          else keys.push(make("char", { text: String.fromCodePoint(code), ...mods }));
          continue;
        }
        // CSI 8 ; rows ; cols t — the terminal answering our window-size query
        if (final === "t" && bits.length >= 3 && bits[0] === 8) {
          keys.push({ name: "resize", id: "resize", rows: bits[1], cols: bits[2] });
          continue;
        }
        const name = final === "Q" ? "f2" : CSI_LETTERS[final];
        if (name) {
          keys.push(make(name, mods));
          continue;
        }
        keys.push(make("unknown", mods));
        continue;
      }

      if (next === "O") {
        // SS3: ESC O A..D (application cursor keys)
        const final = buf[i + 2];
        if (final === undefined) return incomplete(i);
        const name = final === "Q" ? "f2" : CSI_LETTERS[final];
        keys.push(name ? make(name) : make("unknown"));
        i += 3;
        continue;
      }

      // Alt+<key>: ESC followed by a single byte
      const plain = buf[i + 1];
      if (plain === "\r" || plain === "\n") {
        keys.push(make("enter", { alt: true }));
        i += 2;
        continue;
      }
      if (plain === "\x7f" || plain === "\x08") {
        keys.push(make("backspace", { alt: true }));
        i += 2;
        continue;
      }
      if (plain >= " " && plain !== "\x7f") {
        keys.push(make("char", { text: plain, alt: true }));
        i += 2;
        continue;
      }
      keys.push(make("escape"));
      i += 1;
      continue;
    }

    /* ------------------------------ control ------------------------------ */
    const code = ch.charCodeAt(0);
    if (ch === "\r") {
      keys.push(make("enter"));
      i++;
      continue;
    }
    // In raw terminal mode Enter is CR while Ctrl+J is LF. Keeping them
    // distinct makes the documented multiline shortcut actually work.
    if (ch === "\n") {
      keys.push(make("char", { text: "j", ctrl: true }));
      i++;
      continue;
    }
    if (ch === "\t") {
      keys.push(make("tab"));
      i++;
      continue;
    }
    if (ch === "\x7f") {
      keys.push(make("backspace"));
      i++;
      continue;
    }
    if (code === 1) {
      keys.push(make("char", { text: "a", ctrl: true }));
      i++;
      continue;
    }
    if (code >= 1 && code <= 26) {
      keys.push(make("char", { text: String.fromCharCode(96 + code), ctrl: true }));
      i++;
      continue;
    }
    if (code === 27) continue; // handled above
    if (code < 32) {
      i++;
      continue;
    }

    /* ------------------------------ text ------------------------------ */
    // consume a full code point (surrogate pair aware)
    const cp = buf.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    keys.push(make("char", { text: buf.slice(i, i + width) }));
    i += width;
  }

  return { keys, rest: "" };
}

/* ------------------------------------------------------------------ *
 * screen
 * ------------------------------------------------------------------ */

export const out = (s: string) => process.stdout.write(s);

/** filled in when the terminal answers CSI 18 t */
let reportedSize: { cols: number; rows: number } | null = null;

export const screen = {
  /** put the terminal in raw mode so we receive every key */
  raw(on: boolean) {
    if (!isTTY) return;
    try {
      process.stdin.setRawMode?.(on);
    } catch {
      /* not a real tty */
    }
    if (on) process.stdin.resume?.();
  },
  hideCursor() {
    out("\x1b[?25l");
  },
  showCursor() {
    out("\x1b[?25h");
  },
  saveCursor() {
    out("\x1b7");
  },
  restoreCursor() {
    out("\x1b8");
  },
  clearLine() {
    out("\x1b[2K\r");
  },
  clearToEnd() {
    out("\x1b[0J");
  },
  up(n = 1) {
    if (n > 0) out(`\x1b[${n}A`);
  },
  down(n = 1) {
    if (n > 0) out(`\x1b[${n}B`);
  },
  moveTo(col: number) {
    out(`\x1b[${Math.max(1, col)}G`);
  },
  position(row: number, col = 1) {
    out(`\x1b[${Math.max(1, row)};${Math.max(1, col)}H`);
  },
  clear() {
    out("\x1b[2J\x1b[H");
  },
  enterAltScreen() {
    out("\x1b[?1049h");
  },
  leaveAltScreen() {
    out("\x1b[?1049l");
  },
  enableMouse() {
    out("\x1b[?1000h\x1b[?1006h");
  },
  disableMouse() {
    out("\x1b[?1006l\x1b[?1000l");
  },
  /**
   * On Windows, stdout.columns is the *screen buffer* width, which can be much
   * wider than the visible window — drawing to it puts content off-screen to the
   * right. So we ask the terminal for its real text area (CSI 18 t) and use the
   * smaller of the two. Terminals that do not answer keep the old behaviour.
   */
  width(): number {
    const fromBuffer = process.stdout.columns || 80;
    if (reportedSize && reportedSize.cols >= 20 && reportedSize.cols < fromBuffer) return reportedSize.cols;
    // a Windows console buffer is routinely 120–240 wide; never trust it blindly
    if (process.platform === "win32" && !reportedSize) return Math.min(fromBuffer, 100);
    return fromBuffer;
  },
  querySize() {
    if (isTTY) out("[18t");
  },
  noteReportedSize(cols: number, rows: number) {
    if (cols >= 8 && rows >= 3) reportedSize = { cols, rows };
  },
  height(): number {
    const fromBuffer = process.stdout.rows || 24;
    return reportedSize ? Math.min(fromBuffer, reportedSize.rows) : fromBuffer;
  },
  /** query whether the terminal wants to hand paste through bracketed mode */
  enableBracketedPaste() {
    out("\x1b[?2004h");
  },
  disableBracketedPaste() {
    out("\x1b[?2004l");
  },
  /**
   * Kitty keyboard protocol gives us Shift+Enter and friends, but not every
   * terminal understands it; unsupported terminals ignore the sequence.
   */
  enableModifiedKeys() {
    out("\x1b[>1u");
  },
  disableModifiedKeys() {
    out("\x1b[<u");
  },
  /** restore everything we changed, so a crash can't leave a broken shell */
  restore() {
    screen.disableModifiedKeys();
    screen.disableBracketedPaste();
    screen.showCursor();
    screen.raw(false);
  },
};

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Split text at user-perceived character boundaries while retaining UTF-16 offsets. */
export function graphemes(s: string): { text: string; start: number; end: number }[] {
  return [...graphemeSegmenter.segment(s)].map(({ segment, index }) => ({
    text: segment,
    start: index,
    end: index + segment.length,
  }));
}

function graphemeWidth(s: string): number {
  // Joined emoji, flags and emoji presentation sequences occupy one two-cell
  // glyph even though they contain several code points.
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return 2;
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (
      cp === 0x200d ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
      /\p{Mark}/u.test(ch)
    ) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/** display width, ignoring ANSI escapes and counting terminal grapheme cells */
export function displayWidth(s: string): number {
  const plain = s.replace(/\x1b\[[0-9;:?]*[a-zA-Z]|\x1b[78]|\x1b\[<u|\x1b\[>1u/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  return graphemes(plain).reduce((width, part) => width + graphemeWidth(part.text), 0);
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** clip a string to `width` display cells, adding an ellipsis when it had to cut */
export function clip(s: string, width: number): string {
  const plain = s.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, "");
  if (displayWidth(plain) <= width) return s;
  let out2 = "";
  let w = 0;
  const target = Math.max(0, width - 1);
  for (const part of graphemes(plain)) {
    const cw = graphemeWidth(part.text);
    if (w + cw > target) break;
    out2 += part.text;
    w += cw;
  }
  return out2 + "…";
}

/** pad to an exact display width (ANSI aware) */
export function pad(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? clip(s, width) : s + " ".repeat(width - w);
}
