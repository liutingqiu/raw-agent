/**
 * Theme: colours, glyphs and platform-aware key labels.
 *
 * Everything degrades gracefully — NO_COLOR / dumb terminals get plain text,
 * Unicode-poor terminals get ASCII glyphs.
 */
import os from "node:os";

const env = process.env;

export const isTTY = process.stdout.isTTY === true;
export const colorDepth = (() => {
  if (!isTTY || env.NO_COLOR) return 0; // 0 = none, 1 = 16, 2 = 256, 3 = truecolor
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 3;
  if ((env.TERM ?? "").includes("256color")) return 2;
  if (env.TERM === "dumb") return 0;
  return 1;
})();

/** Unicode box drawing is safe nearly everywhere except legacy Windows consoles. */
/**
 * Box drawing works on modern Windows consoles too (Node writes UTF-8 through
 * WriteConsoleW), so Unicode is the default and RAW_ASCII=1 is the escape hatch.
 */
export const unicode = !env.RAW_ASCII && env.TERM !== "dumb";

export const glyph = {
  tl: unicode ? "╭" : "+",
  tr: unicode ? "╮" : "+",
  bl: unicode ? "╰" : "+",
  br: unicode ? "╯" : "+",
  h: unicode ? "─" : "-",
  v: unicode ? "│" : "|",
  bullet: unicode ? "•" : "*",
  arrow: unicode ? "❯" : ">",
  check: unicode ? "✓" : "v",
  cross: unicode ? "✗" : "x",
  branch: unicode ? "⎿" : "\\",
  ellipsis: unicode ? "…" : "...",
  dot: unicode ? "·" : "-",
  bar: unicode ? ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] : ["_", "-", "=", "#"],
  meterFull: unicode ? "█" : "#",
  meterEmpty: unicode ? "░" : ".",
  spark: unicode ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] : ["|", "/", "-", "\\"],
  pulse: unicode ? ["◜", "◠", "◝", "◞", "◡", "◟"] : ["(", "-", ")", "-"],
};

/* ------------------------------- colour ------------------------------- */

type Rgb = [number, number, number];

const fg16 = (n: number) => `\x1b[${n}m`;
const fg256 = (n: number) => `\x1b[38;5;${n}m`;
const fgRgb = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;

export const reset = colorDepth ? "\x1b[0m" : "";

/** style functions; paint() also accepts raw ANSI codes */
export type Style = string | ((s: string) => string) | undefined | null | false;
const wrap = (code: string) => (s: string) => (colorDepth ? code + s + reset : s);
export const bold = wrap("\x1b[1m");
export const dim = wrap("\x1b[2m");
export const italic = wrap("\x1b[3m");
export const underline = wrap("\x1b[4m");
export const inverse = wrap("\x1b[7m");

export function paint(s: string, ...styles: Style[]): string {
  let body = s;
  const codes: string[] = [];
  for (const st of styles) {
    if (!st) continue;
    if (typeof st === "function") body = st(body);
    else codes.push(st);
  }
  return colorDepth && codes.length ? codes.join("") + body + reset : body;
}

/** a colour that adapts to the terminal's capability */
export function color(rgb: Rgb, fallback256 = 250, fallback16 = 37) {
  if (colorDepth >= 3) return fgRgb(rgb);
  if (colorDepth === 2) return fg256(fallback256);
  if (colorDepth === 1) return fg16(fallback16);
  return "";
}

/* ------------------------------- palette ------------------------------- */

export const theme = {
  accent: color([122, 162, 247], 111, 36), // soft blue
  accentDim: color([86, 114, 173], 61, 34),
  ok: color([158, 206, 106], 149, 32),
  warn: color([224, 175, 104], 179, 33),
  err: color([247, 118, 142], 204, 31),
  info: color([125, 207, 255], 117, 36),
  text: "",
  muted: color([86, 95, 137], 60, 90),
  faint: color([60, 66, 92], 238, 90),
  brand: color([187, 154, 247], 141, 35), // soft violet
  brandAlt: color([255, 199, 119], 222, 33),
};

/** truecolor gradient sweep, used for the wordmark */
export function gradient(text: string, from: Rgb, to: Rgb, offset = 0): string {
  if (colorDepth < 3) return paint(text, theme.brand);
  const chars = [...text];
  return chars
    .map((ch, i) => {
      const t = chars.length <= 1 ? 1 : i / (chars.length - 1);
      const wobble = 0.12 * Math.sin((i + offset) * 0.9);
      const k = Math.min(1, Math.max(0, t + wobble));
      const rgb: Rgb = [
        Math.round(from[0] + (to[0] - from[0]) * k),
        Math.round(from[1] + (to[1] - from[1]) * k),
        Math.round(from[2] + (to[2] - from[2]) * k),
      ];
      return fgRgb(rgb) + ch;
    })
    .join("") + reset;
}

/* ------------------------------- keys ------------------------------- */

export const isMac = process.platform === "darwin";
export const isWindows = process.platform === "win32";

const CTRL = isMac ? "⌃" : "Ctrl+";
const ALT = isMac ? "⌥" : "Alt+";
const SHIFT = isMac ? "⇧" : "Shift+";
const META = isMac ? "⌘" : "Win+";

/**
 * One keybinding table, three platforms. `keys` is what the binding accepts;
 * `label` is what the user is shown.
 */
export type Binding = {
  id: string;
  win: string;
  mac: string;
  linux: string;
  what: string;
  /** accepted encodings, matched by the key parser */
  match: string[];
};

export const bindings: Binding[] = [
  { id: "submit", win: "Enter", mac: "Enter", linux: "Enter", what: "send", match: ["enter"] },
  { id: "settings", win: "F2", mac: "F2", linux: "F2", what: "open interactive settings", match: ["f2"] },
  {
    id: "newline",
    win: "Ctrl+J / Shift+Enter",
    mac: "⌃J / ⇧Enter",
    linux: "Ctrl+J / Shift+Enter",
    what: "new line",
    match: ["ctrl+j", "shift+enter", "alt+enter"],
  },
  { id: "interrupt", win: "Esc", mac: "Esc", linux: "Esc", what: "stop generating", match: ["escape"] },
  { id: "clear-input", win: "Ctrl+C", mac: "⌃C", linux: "Ctrl+C", what: "clear the input line", match: ["ctrl+c"] },
  { id: "exit", win: "Ctrl+D", mac: "⌃D", linux: "Ctrl+D", what: "exit (on an empty line)", match: ["ctrl+d"] },
  { id: "history", win: "↑ / ↓", mac: "↑ / ↓", linux: "↑ / ↓", what: "browse history", match: ["up", "down"] },
  { id: "word", win: "Ctrl+← / →", mac: "⌥← / →", linux: "Ctrl+← / →", what: "jump by word", match: ["ctrl+left", "ctrl+right", "alt+left", "alt+right"] },
  { id: "line", win: "Home / End", mac: "⌃A / ⌃E", linux: "Home / End", what: "jump to line ends", match: ["home", "end", "ctrl+a", "ctrl+e"] },
  { id: "kill-word", win: "Ctrl+Backspace", mac: "⌥⌫", linux: "Ctrl+W", what: "delete previous word", match: ["ctrl+w", "alt+backspace", "ctrl+backspace"] },
  { id: "kill-line", win: "Ctrl+U", mac: "⌃U", linux: "Ctrl+U", what: "clear the whole line", match: ["ctrl+u"] },
  { id: "paste-image", win: "Ctrl+G", mac: "⌃G", linux: "Ctrl+G", what: "attach an image from the clipboard", match: ["ctrl+g"] },
  {
    id: "permission",
    win: "Shift+Tab",
    mac: "⇧⇥",
    linux: "Shift+Tab",
    what: "cycle permission mode",
    match: ["shift+tab"],
  },
  { id: "expand", win: "Ctrl+O", mac: "⌃O", linux: "Ctrl+O", what: "expand the last tool output", match: ["ctrl+o"] },
  { id: "commands", win: "/", mac: "/", linux: "/", what: "slash commands (Tab to complete)", match: [] },
  { id: "files", win: "@", mac: "@", linux: "@", what: "reference a file", match: [] },
];

export function keyLabel(id: string): string {
  const b = bindings.find((x) => x.id === id);
  if (!b) return "";
  return isMac ? b.mac : isWindows ? b.win : b.linux;
}

/** Words used in help panels: "Ctrl+C", "⌃C", … */
export const keyWords = { ctrl: CTRL, alt: ALT, shift: SHIFT, meta: META };

export function platformName(): string {
  if (isMac) return `macOS ${os.release()}`;
  if (isWindows) return `Windows ${os.release()}`;
  return `${os.type()} ${os.release()}`;
}
