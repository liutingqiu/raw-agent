import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseKeys } from "../src/tui/term.ts";
import { Editor } from "../src/tui/editor.ts";
import { clip, displayWidth, pad, screen } from "../src/tui/term.ts";
import { Block, fitViewport, statusLine, meter, humanTokens, rule, startupLines } from "../src/tui/ui.ts";
import { commandCompletions, findCommand, PERMISSION_ORDER } from "../src/tui/commands.ts";
import { renderSettings } from "../src/tui/settings.ts";

/* ------------------------------------------------------------------ *
 * key parsing
 * ------------------------------------------------------------------ */

test("plain characters, control keys and enter", () => {
  const { keys } = parseKeys("hi\r\u0003\u0004\t\u007f");
  assert.deepEqual(
    keys.map((k) => k.id),
    ["h", "i", "enter", "ctrl+c", "ctrl+d", "tab", "backspace"],
  );
  assert.equal(keys[0].text, "h");
  assert.equal(keys[1].text, "i");
});

test("arrow / navigation escape sequences", () => {
  const { keys } = parseKeys("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F");
  assert.deepEqual(
    keys.map((k) => k.name),
    ["up", "down", "right", "left", "home", "end"],
  );
});

test("modified arrows carry their modifiers", () => {
  const { keys } = parseKeys("\x1b[1;5C\x1b[1;3D\x1b[Z");
  assert.equal(keys[0].id, "ctrl+right");
  assert.equal(keys[1].id, "alt+left");
  assert.equal(keys[2].id, "shift+tab");
});

test("F2 and SGR mouse reports are decoded", () => {
  const { keys } = parseKeys("\x1bOQ\x1b[12~\x1b[<0;24;7M\x1b[<0;24;7m");
  assert.deepEqual(keys.slice(0, 2).map((key) => key.name), ["f2", "f2"]);
  assert.deepEqual(
    { name: keys[2].name, x: keys[2].x, y: keys[2].y, button: keys[2].button, action: keys[2].mouseAction },
    { name: "mouse", x: 24, y: 7, button: "left", action: "press" },
  );
  assert.equal(keys[3].mouseAction, "release");
});

test("all xterm modifier combinations are decoded from the encoded bitmask", () => {
  const { keys } = parseKeys("\x1b[1;4C\x1b[1;8D");
  assert.equal(keys[0].id, "alt+shift+right");
  assert.equal(keys[1].id, "ctrl+alt+shift+left");
});

test("kitty modified enter and backspace become semantic keys", () => {
  const { keys } = parseKeys("\x1b[13;2u\x1b[127;5u\x1b\x7f");
  assert.deepEqual(keys.map((key) => key.id), ["shift+enter", "ctrl+backspace", "alt+backspace"]);
});

test("raw LF is Ctrl+J while CR remains Enter", () => {
  const { keys } = parseKeys("\n\r");
  assert.deepEqual(keys.map((key) => key.id), ["ctrl+j", "enter"]);
});

test("delete / pageup / pagedown tilde sequences", () => {
  const { keys } = parseKeys("\x1b[3~\x1b[5~\x1b[6~");
  assert.deepEqual(
    keys.map((k) => k.name),
    ["delete", "pageup", "pagedown"],
  );
});

test("bracketed paste is returned as one event", () => {
  const { keys } = parseKeys("\x1b[200~line one\nline two\x1b[201~x");
  assert.equal(keys[0].name, "paste");
  assert.equal(keys[0].text, "line one\nline two");
  assert.equal(keys[1].text, "x");
});

test("an incomplete escape sequence is held back, not misread", () => {
  const { keys, rest } = parseKeys("ab\x1b[");
  assert.deepEqual(keys.map((k) => k.text), ["a", "b"]);
  assert.equal(rest, "\x1b[");
});

test("alt+key and multi-byte characters survive", () => {
  const { keys } = parseKeys("\x1bb中");
  assert.equal(keys[0].id, "alt+b");
  assert.equal(keys[1].text, "中");
});

/* ------------------------------------------------------------------ *
 * the editor
 * ------------------------------------------------------------------ */

const type = (ed, text) => {
  for (const ch of text) ed.handle({ name: "char", text: ch, id: "char" });
};

test("typing, cursor movement and submission", () => {
  const ed = new Editor();
  type(ed, "hello world");
  ed.handle({ name: "left", id: "left" });
  ed.handle({ name: "left", id: "left" });
  type(ed, "X");
  assert.equal(ed.text(), "hello worXld");

  ed.handle({ name: "home", id: "home" });
  type(ed, ">");
  assert.equal(ed.text(), ">hello worXld");

  const action = ed.handle({ name: "enter", id: "enter" });
  assert.equal(action?.type, "submit");
  assert.equal(action.type === "submit" && action.text, ">hello worXld");
});

test("submit is ignored while the line is empty", () => {
  const ed = new Editor();
  assert.equal(ed.handle({ name: "enter", id: "enter" }), null);
});

test("ctrl+c clears the line, ctrl+d exits only when empty", () => {
  const ed = new Editor();
  type(ed, "draft");
  assert.equal(ed.handle({ name: "char", text: "c", ctrl: true, id: "ctrl+c" }), null);
  assert.equal(ed.text(), "");
  assert.equal(ed.handle({ name: "char", text: "d", ctrl: true, id: "ctrl+d" })?.type, "exit");
  type(ed, "x");
  assert.equal(ed.handle({ name: "char", text: "d", ctrl: true, id: "ctrl+d" }), null);
});

test("emoji and combining characters move and delete as whole graphemes", () => {
  const ed = new Editor();
  type(ed, "A👩🏽‍💻e\u0301B");
  ed.handle({ name: "left", id: "left" });
  ed.handle({ name: "backspace", id: "backspace" });
  assert.equal(ed.text(), "A👩🏽‍💻B");
  ed.handle({ name: "home", id: "home" });
  ed.handle({ name: "right", id: "right" });
  ed.handle({ name: "delete", id: "delete" });
  assert.equal(ed.text(), "AB");
});

test("multiline editing with ctrl+j and enter-to-submit", () => {
  const ed = new Editor();
  type(ed, "one");
  ed.handle({ name: "char", text: "j", ctrl: true, id: "ctrl+j" });
  type(ed, "two");
  assert.equal(ed.text(), "one\ntwo");
  assert.equal(ed.row, 1);
  const action = ed.handle({ name: "enter", id: "enter" });
  assert.equal(action?.type === "submit" && action.text, "one\ntwo");
  assert.equal(action?.type === "submit" && action.text.includes("\n"), true);
});

test("shift-enter adds a line and shift-tab cycles permission", () => {
  const ed = new Editor();
  type(ed, "one");
  assert.equal(ed.handle({ name: "enter", shift: true, id: "shift+enter" }), null);
  type(ed, "two");
  assert.equal(ed.text(), "one\ntwo");
  assert.equal(ed.handle({ name: "tab", shift: true, id: "shift+tab" })?.type, "permission-cycle");
});

test("modified backspace deletes a word", () => {
  const ed = new Editor();
  type(ed, "alpha beta");
  ed.handle({ name: "backspace", alt: true, id: "alt+backspace" });
  assert.equal(ed.text(), "alpha ");
});

test("word and line operations", () => {
  const ed = new Editor();
  type(ed, "alpha beta gamma");
  ed.handle({ name: "char", text: "w", ctrl: true, id: "ctrl+w" });
  assert.equal(ed.text(), "alpha beta ");
  ed.handle({ name: "home", id: "home" });
  ed.handle({ name: "right", ctrl: true, id: "ctrl+right" });
  assert.equal(ed.col, 5);
  ed.handle({ name: "char", text: "u", ctrl: true, id: "ctrl+u" });
  assert.equal(ed.text(), " beta ");
});

test("history navigation restores the draft", () => {
  const ed = new Editor();
  ed.remember("first");
  ed.remember("second");
  type(ed, "draft");
  ed.handle({ name: "up", id: "up" });
  assert.equal(ed.text(), "second");
  ed.handle({ name: "up", id: "up" });
  assert.equal(ed.text(), "first");
  ed.handle({ name: "down", id: "down" });
  ed.handle({ name: "down", id: "down" });
  assert.equal(ed.text(), "draft");
});

test("enter executes the highlighted slash command in one step", () => {
  const ed = new Editor();
  ed.completer = (token, kind) => (kind === "command" ? commandCompletions(token) : []);
  type(ed, "/mo");
  ed.refreshMenu();
  assert.ok(ed.menu.length >= 1);
  assert.equal(ed.menu[0].value, "/model");
  const action = ed.handle({ name: "enter", id: "enter" });
  assert.equal(action?.type, "submit");
  assert.equal(action?.type === "submit" && action.text, "/model");
});

test("up and down select slash commands before enter executes one", () => {
  const ed = new Editor();
  ed.completer = (token, kind) => (kind === "command" ? commandCompletions(token) : []);
  type(ed, "/");
  assert.ok(ed.menu.length > 3);
  ed.handle({ name: "up", id: "up" });
  assert.equal(ed.menuView(20).find((item) => item.selected)?.label, "/exit");
  ed.handle({ name: "down", id: "down" });
  const contextIndex = ed.menu.findIndex((item) => item.value === "/context");
  for (let i = 0; i < contextIndex; i++) ed.handle({ name: "down", id: "down" });
  assert.equal(ed.menuView(6).find((item) => item.selected)?.label, "/context");
  const action = ed.handle({ name: "enter", id: "enter" });
  assert.deepEqual(action, { type: "submit", text: "/context" });
});

test("escape closes the completion menu instead of interrupting", () => {
  const ed = new Editor();
  ed.completer = (t, k) => (k === "command" ? commandCompletions(t) : []);
  type(ed, "/co");
  ed.refreshMenu();
  assert.ok(ed.menu.length > 0);
  assert.equal(ed.handle({ name: "escape", id: "escape" }), null);
  assert.equal(ed.menu.length, 0);
  assert.equal(ed.handle({ name: "escape", id: "escape" })?.type, "interrupt");
});

test("pasting keeps newlines", () => {
  const ed = new Editor();
  ed.handle({ name: "paste", text: "a\nb\nc", id: "paste" });
  assert.equal(ed.text(), "a\nb\nc");
  assert.equal(ed.row, 2);
});

test("attachments are tracked and cleared", () => {
  const ed = new Editor();
  ed.attach({ mime: "image/png", data: "AAA" }, "shot.png");
  assert.equal(ed.isEmpty(), false);
  assert.deepEqual(ed.attachmentChips(), ["[1] shot.png"]);
  assert.equal(ed.handle({ name: "enter", id: "enter" })?.type, "submit");
  ed.clear();
  assert.equal(ed.attachments.length, 0);
  assert.equal(ed.isEmpty(), true);
});

test("a fully typed command submits on the first enter", () => {
  const ed = new Editor();
  ed.completer = (token, kind) => (kind === "command" ? commandCompletions(token) : []);
  type(ed, "/context");
  const action = ed.handle({ name: "enter", id: "enter" });
  assert.equal(action?.type, "submit");
  assert.equal(action?.type === "submit" && action.text, "/context");
});

test("backspace on empty input removes the latest attachment", () => {
  const ed = new Editor();
  ed.attach({ mime: "image/png", data: "AAA" }, "one.png");
  ed.attach({ mime: "image/png", data: "BBB" }, "two.png");
  ed.handle({ name: "backspace", id: "backspace" });
  assert.deepEqual(ed.attachmentChips(), ["[1] one.png"]);
});

/* ------------------------------------------------------------------ *
 * rendering maths
 * ------------------------------------------------------------------ */

test("display width counts CJK as two cells and ignores colour codes", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("中文"), 4);
  assert.equal(displayWidth("\x1b[31mabc\x1b[0m"), 3);
  assert.equal(displayWidth("e\u0301"), 1);
  assert.equal(displayWidth("👩🏽‍💻"), 2);
  assert.equal(displayWidth("🇨🇳"), 2);
});

test("clip and pad respect display width", () => {
  assert.equal(displayWidth(clip("中".repeat(20), 10)), 9); // 4 wide chars + ellipsis
  assert.equal(displayWidth(pad("ab", 6)), 6);
  assert.equal(displayWidth(pad("中文", 6)), 6);
});

test("the editor wraps long input and places the cursor", () => {
  const ed = new Editor();
  type(ed, "x".repeat(30));
  const view = ed.render(20, "> ");
  assert.ok(view.rows.length >= 2, "should wrap onto a second row");
  assert.ok(view.cursorRow >= 1);
  assert.ok(view.cursorCol <= 20);
  // every rendered row must fit the terminal
  for (const r of view.rows) assert.ok(displayWidth(r) <= 20, `row too wide: ${JSON.stringify(r)}`);
});

test("meter and humanised token counts", () => {
  assert.equal(humanTokens(999), "999");
  assert.equal(humanTokens(12_300), "12k");
  assert.equal(humanTokens(2_500_000), "2.5M");
  const m = meter(5, 10, 10);
  assert.equal(displayWidth(m), 10);
  assert.equal(displayWidth(meter(0, 0, 4)), 4);
});

test("the status line always fits the terminal", () => {
  for (const width of [40, 80, 120]) {
    const line = statusLine(
      { provider: "p", model: "deepseek-flash", effort: "high", permission: "auto", used: 12_345, total: 128_000, streaming: false, turns: 3 },
      width,
    );
    assert.equal(displayWidth(line), width, `width ${width}`);
  }
});

test("up and down move through visual wraps before browsing history", () => {
  const ed = new Editor();
  ed.remember("older history");
  type(ed, "x".repeat(30));
  ed.render(12, "> ");
  ed.handle({ name: "up", id: "up" });
  assert.equal(ed.text(), "x".repeat(30));
  assert.ok(ed.col >= 10 && ed.col < 20);
  ed.render(12, "> ");
  ed.handle({ name: "up", id: "up" });
  assert.equal(ed.text(), "x".repeat(30));
  assert.ok(ed.col < 10);
  ed.render(12, "> ");
  ed.handle({ name: "up", id: "up" });
  assert.equal(ed.text(), "older history");
});

test("the hint rule never exceeds a narrow terminal", () => {
  for (const width of [8, 12, 20, 40]) {
    assert.equal(displayWidth(rule(width, "/ commands  @ files  ? help  Shift+Tab mode")), width);
  }
});

test("the startup card fits narrow terminal widths", () => {
  const info = {
    version: "0.4.0", provider: "long-provider", model: "long-model", effort: "high",
    permission: "readonly", workspace: "D:/a very long workspace/path", toolCount: 10, configured: true,
  };
  for (const width of [8, 10, 12, 20, 40]) {
    for (const line of startupLines(info, width)) assert.equal(displayWidth(line), Math.max(4, width));
  }
});

test("the input viewport stays within height and keeps the cursor visible", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i}`);
  assert.deepEqual(fitViewport(lines, 0, 4), { lines: lines.slice(0, 4), cursorRow: 0, start: 0 });
  assert.deepEqual(fitViewport(lines, 10, 4), { lines: lines.slice(7, 11), cursorRow: 3, start: 7 });
  assert.deepEqual(fitViewport(lines, 19, 4), { lines: lines.slice(16), cursorRow: 3, start: 16 });
});

/* ------------------------------------------------------------------ *
 * command table
 * ------------------------------------------------------------------ */

test("the command table is coherent", () => {
  const names = ["help", "settings", "goal", "context", "compact", "model", "effort", "permission", "paste", "image", "tools", "notes", "session", "new", "exit"];
  for (const n of names) assert.ok(findCommand(n), `missing /${n}`);
  assert.equal(findCommand("?")?.name, "help");
  assert.equal(findCommand("permissions")?.name, "permission");
  assert.equal(findCommand("nope"), undefined);
  for (const c of commandCompletions("")) assert.ok(c.value.startsWith("/"));
  assert.deepEqual(PERMISSION_ORDER, ["auto", "ask", "readonly"]);
});

test("settings panel exposes keyboard rows and clickable values", () => {
  const frame = renderSettings(
    { contextWindow: 128_000, permission: "auto", effort: "high", showReasoning: false },
    1,
    80,
    24,
  );
  assert.deepEqual(frame.rows.map((row) => row.key), ["permission", "context", "effort", "reasoning"]);
  const contextHit = frame.hits.find((hit) => hit.row === 1 && hit.value === "256000");
  assert.ok(contextHit);
  assert.ok(contextHit.x1 <= contextHit.x2 && contextHit.y > 0);
  assert.match(frame.lines.join("\n"), /raw settings/);
});

test("the context command accepts a user-defined token window", async () => {
  let cfg = { provider: "p", model: "m", contextWindow: 128_000 };
  const output = [];
  const command = findCommand("context");
  await command.run({
    cfg,
    setConfig(next) { cfg = next; },
    messages: [],
    permission: "auto",
    showReasoning: false,
    goal: null,
    sessionFile: "session.json",
    print(line = "") { output.push(line); },
  }, "1m");
  assert.equal(cfg.contextWindow, 1_000_000);
  assert.match(output.join("\n"), /1,000,000/);
});

/* ------------------------------------------------------------------ *
 * the two bugs from the first real terminal run
 * ------------------------------------------------------------------ */

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

test("an unchanged block repaints nothing (idle flicker)", () => {
  const written = capture(() => {
    const b = new Block();
    b.render(["prompt", "hint", "status"], 0, 0);
    const out = capture(() => b.render(["prompt", "hint", "status"], 0, 0));
    assert.equal(out, "", "identical frame must not be written again");
  });
  assert.ok(written.length > 0, "the first frame still has to be drawn");
});

test("a changed block is cleared line by line, never to end of screen", () => {
  const b = new Block();
  capture(() => b.render(["a", "b", "c"], 0, 0));
  const second = capture(() => b.render(["a", "b", "d"], 0, 0));
  const clears = (second.match(/\x1b\[2K/g) ?? []).length;
  assert.equal(clears, 3, "each drawn row must be cleared individually");
  assert.ok(!second.includes("\x1b[0J"), "must not clear to end of screen — scrolling breaks that");
});

test("erase clears exactly the rows it drew, and only once", () => {
  const b = new Block();
  capture(() => b.render(["prompt", "hint", "status"], 0, 0));
  const firstErase = capture(() => b.erase());
  assert.equal((firstErase.match(/\x1b\[2K/g) ?? []).length, 3);
  assert.equal(capture(() => b.erase()), "", "erasing an empty block must write nothing");
  assert.equal(b.height, 0);
});

test("accepting a completion keeps the menu closed afterwards", () => {
  const ed = new Editor();
  ed.completer = (t, k) => (k === "command" ? commandCompletions(t) : []);
  type(ed, "/eff");
  ed.refreshMenu();
  assert.equal(ed.menu[0].value, "/effort");
  assert.equal(ed.handle({ name: "tab", id: "tab" }), null);
  assert.equal(ed.text(), "/effort ");
  assert.equal(ed.menu.length, 0);
});

test("completion preserves text after the cursor", () => {
  const ed = new Editor();
  ed.completer = (t, k) => (k === "command" ? [{ value: "/model" }] : []);
  ed.setText("/mo tail");
  ed.col = 3;
  ed.refreshMenu();
  ed.handle({ name: "tab", id: "tab" });
  assert.equal(ed.text(), "/model  tail");
});

test("quoted file completion supports paths with spaces", () => {
  const ed = new Editor();
  ed.completer = (t, k) => (k === "file" && t === "my dir/f" ? [{ value: '@"my dir/file.txt"' }] : []);
  type(ed, '@"my dir/f');
  ed.handle({ name: "tab", id: "tab" });
  assert.equal(ed.text(), '@"my dir/file.txt"');
});

test("the selected completion remains visible when the menu scrolls", () => {
  const ed = new Editor();
  ed.menu = Array.from({ length: 12 }, (_, i) => ({ value: `/item-${i}` }));
  ed.menuIndex = 10;
  const view = ed.menuView(6);
  assert.equal(view.length, 6);
  assert.equal(view.some((item) => item.selected && item.label === "/item-10"), true);
});

test("the terminal's window-size reply (CSI 18 t) is parsed", () => {
  const { keys } = parseKeys("\x1b[8;30;85t");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, "resize");
  assert.equal(keys[0].cols, 85);
  assert.equal(keys[0].rows, 30);
});

test("a size reply is not confused with a normal key sequence", () => {
  const { keys } = parseKeys("a\x1b[8;24;80tb");
  assert.deepEqual(keys.map((k) => k.name), ["char", "resize", "char"]);
  assert.equal(keys[1].cols, 80);
});

test("screen.width never exceeds the reported window size", () => {
  const before = screen.width();
  screen.noteReportedSize(85, 30);
  const after = screen.width();
  assert.ok(after <= 85, `expected <= 85, got ${after}`);
  // a report larger than the buffer must not be trusted either
  screen.noteReportedSize(9999, 9999);
  assert.ok(screen.width() <= before + 1);
});
