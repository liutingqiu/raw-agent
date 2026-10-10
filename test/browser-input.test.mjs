import "./_setup.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { interpolatePath, modifierMask, readBridgeConfig } from "../src/browser.ts";

const repo = path.resolve(import.meta.dirname, "..");
const helpersSource = fs.readFileSync(path.join(repo, "src", "page-helpers.js"), "utf8");

/* ------------------------------------------------------------------ *
 * a minimal DOM good enough to run the page-side helper
 * ------------------------------------------------------------------ */

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles === true;
  }
}

class FakeInputEvent extends FakeEvent {
  constructor(type, init = {}) {
    super(type, init);
    this.data = init.data;
    this.inputType = init.inputType;
  }
}

class FakeInput {
  constructor() {
    this._value = "";
    this.nativeSets = 0;
  }
  get value() {
    return this._value;
  }
  set value(next) {
    this.nativeSets++;
    this._value = next;
  }
}

class FakeTextArea extends FakeInput {}
class FakeSelect extends FakeInput {}

function loadHelpers() {
  const state = { matched: [], exec: [] };

  const document = {
    querySelectorAll(selector) {
      return selector === "iframe,frame" ? [] : state.matched;
    },
    getElementById() {
      return null;
    },
    documentElement: {},
    createRange() {
      return { selectNodeContents() {} };
    },
    execCommand(command, _ui, text) {
      state.exec.push({ command, text });
      return command === "insertText";
    },
  };

  const window = {
    document,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: FakeSelect,
    InputEvent: FakeInputEvent,
    Event: FakeEvent,
    getSelection() {
      return { removeAllRanges() {}, addRange() {} };
    },
    getComputedStyle() {
      return { visibility: "visible", display: "block", opacity: "1" };
    },
  };
  window.window = window;
  Object.defineProperty(document, "defaultView", { get: () => window });

  const context = vm.createContext({ window, document, Event: FakeEvent, console });
  vm.runInContext(helpersSource, context, { filename: "page-helpers.js" });

  const makeElement = (overrides = {}) => {
    const el = new FakeInput();
    el.tagName = "INPUT";
    el.isContentEditable = false;
    el.events = [];
    el.classList = { contains: () => false };
    el.closest = () => null;
    el.querySelector = () => null;
    el.focus = () => {};
    el.scrollIntoView = () => {};
    el.dispatchEvent = function dispatchEvent(event) {
      this.events.push(event);
    };
    el.contains = (node) => node === el;
    el.ownerDocument = document;
    return Object.assign(el, overrides);
  };

  return { mai: window.__mai, window, document, state, makeElement };
}

/* ------------------------------ setValue ------------------------------ */

test("setValue writes through the Monaco editor that owns the element", () => {
  const { mai, window, state, makeElement } = loadHelpers();
  const el = makeElement();
  state.matched = [el];
  const written = [];
  window.monaco = {
    editor: {
      getEditors: () => [{ getDomNode: () => el, setValue: (text) => written.push(text) }],
    },
  };

  const result = mai.setValue("css=#code", "print(1)");

  assert.deepEqual({ ...result }, { ok: true, strategy: "monaco", length: 8 });
  assert.deepEqual(written, ["print(1)"]);
});

test("setValue refuses to guess when several Monaco editors exist and none owns the element", () => {
  const { mai, window, state, makeElement } = loadHelpers();
  const el = makeElement({ querySelector: (selector) => (selector === ".monaco-editor" ? {} : null) });
  state.matched = [el];
  let wrote = false;
  window.monaco = {
    editor: {
      getEditors: () => [
        { getDomNode: () => makeElement(), setValue: () => { wrote = true; } },
        { getDomNode: () => makeElement(), setValue: () => { wrote = true; } },
      ],
    },
  };

  const result = mai.setValue("css=#code", "x");

  assert.equal(result.ok, false);
  assert.equal(result.strategy, "monaco-ambiguous");
  assert.match(result.detail, /2 editors/);
  assert.equal(wrote, false, "an ambiguous Monaco page must not receive the text");
});

test("a lone Monaco editor still serves writes aimed at its own container", () => {
  const { mai, window, state, makeElement } = loadHelpers();
  const container = makeElement({
    tagName: "DIV",
    querySelector: (selector) => (selector === ".monaco-editor" ? {} : null),
  });
  state.matched = [container];
  const written = [];
  window.monaco = {
    editor: { getEditors: () => [{ getDomNode: () => makeElement(), setValue: (text) => written.push(text) }] },
  };

  const result = mai.setValue("css=#monaco", "print(1)");

  assert.equal(result.strategy, "monaco-single");
  assert.deepEqual(written, ["print(1)"]);
});

test("a lone Monaco editor does not swallow writes aimed at unrelated fields", () => {
  const { mai, window, state, makeElement } = loadHelpers();
  const field = makeElement({ tagName: "INPUT" });
  state.matched = [field];
  let wrote = false;
  window.monaco = {
    editor: { getEditors: () => [{ getDomNode: () => makeElement(), setValue: () => { wrote = true; } }] },
  };

  const result = mai.setValue("css=#name", "Tianqi");

  assert.equal(result.strategy, "input", "an unrelated field must use its own setter");
  assert.equal(field.value, "Tianqi");
  assert.equal(wrote, false, "the editor must never receive text meant for another element");
});

test("setValue prefers the focused Monaco editor over an arbitrary one", () => {
  const { mai, window, state, makeElement } = loadHelpers();
  const el = makeElement();
  state.matched = [el];
  const written = [];
  window.monaco = {
    editor: {
      getEditors: () => [
        { getDomNode: () => makeElement(), hasTextFocus: () => false, setValue: () => { written.push("wrong"); } },
        { getDomNode: () => makeElement(), hasTextFocus: () => true, setValue: (text) => written.push(text) },
      ],
    },
  };

  const result = mai.setValue("css=#code", "focused");

  assert.equal(result.strategy, "monaco-focused");
  assert.deepEqual(written, ["focused"]);
});

test("setValue writes through CodeMirror 5", () => {
  const { mai, state, makeElement } = loadHelpers();
  const written = [];
  const host = { CodeMirror: { setValue: (text) => written.push(text) } };
  const el = makeElement({ closest: (selector) => (selector === ".CodeMirror" ? host : null) });
  state.matched = [el];

  const result = mai.setValue("css=#code", "y = 2");

  assert.equal(result.strategy, "codemirror5");
  assert.deepEqual(written, ["y = 2"]);
});

test("setValue writes through CodeMirror 6 by dispatching a document change", () => {
  const { mai, state, makeElement } = loadHelpers();
  const dispatched = [];
  const view = { state: { doc: { length: 4 } }, dispatch: (tr) => dispatched.push(tr) };
  const el = makeElement({ cmView: { view } });
  state.matched = [el];

  const result = mai.setValue("css=#code", "hello");

  assert.equal(result.strategy, "codemirror6");
  assert.equal(dispatched.length, 1);
  assert.deepEqual({ ...dispatched[0].changes }, { from: 0, to: 4, insert: "hello" });
});

test("setValue falls back to execCommand for contenteditable regions", () => {
  const { mai, state, makeElement } = loadHelpers();
  const el = makeElement({ tagName: "DIV", isContentEditable: true });
  state.matched = [el];

  const result = mai.setValue("css=#prompt", "draft text");

  assert.equal(result.strategy, "contenteditable");
  assert.deepEqual(state.exec, [{ command: "insertText", text: "draft text" }]);
});

test("setValue drives React-controlled inputs through the native value setter", () => {
  const { mai, state, makeElement } = loadHelpers();
  const el = makeElement({ tagName: "INPUT" });
  state.matched = [el];

  const result = mai.setValue("css=#name", "Tianqi");

  assert.equal(result.strategy, "input");
  assert.equal(el.nativeSets, 1, "the prototype setter must be used so React sees the change");
  assert.equal(el.value, "Tianqi");
  assert.deepEqual(
    el.events.map((event) => event.type),
    ["input", "change"],
  );
  assert.equal(el.events[0].inputType, "insertText");
});

test("setValue appends instead of replacing when asked", () => {
  const { mai, state, makeElement } = loadHelpers();
  const el = makeElement({ tagName: "TEXTAREA" });
  el.value = "line one\n";
  state.matched = [el];

  const result = mai.setValue("css=#notes", "line two", { append: true });

  assert.equal(result.strategy, "input");
  assert.equal(el.value, "line one\nline two");
});

test("setValue reports a miss instead of silently succeeding", () => {
  const { mai } = loadHelpers();

  const result = mai.setValue("css=#missing", "x");

  assert.equal(result.ok, false);
  assert.equal(result.strategy, "none");
  assert.match(result.detail, /element not found/);
});

/* --------------------------- bridge config --------------------------- */

const bridgeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "raw-bridge-test-"));

test("readBridgeConfig reads the token and port the installer wrote", () => {
  const dir = bridgeDir();
  fs.writeFileSync(path.join(dir, "edge-bridge.json"), JSON.stringify({ version: 1, token: "abc-123", port: 9444 }));

  assert.deepEqual({ ...readBridgeConfig(dir) }, { token: "abc-123", port: 9444 });

  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBridgeConfig degrades quietly on a missing or malformed config", () => {
  const dir = bridgeDir();

  assert.deepEqual({ ...readBridgeConfig(dir) }, {});

  fs.writeFileSync(path.join(dir, "edge-bridge.json"), "{ this is not json");
  assert.deepEqual({ ...readBridgeConfig(dir) }, {});

  fs.rmSync(dir, { recursive: true, force: true });
});

test("readBridgeConfig rejects an empty token and a non-numeric port", () => {
  const dir = bridgeDir();
  fs.writeFileSync(path.join(dir, "edge-bridge.json"), JSON.stringify({ token: "", port: "9333" }));

  assert.deepEqual({ ...readBridgeConfig(dir) }, { token: undefined, port: undefined });

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------ pointer ------------------------------ */

test("modifierMask maps names to the CDP modifier bitmask", () => {
  assert.equal(modifierMask(), 0);
  assert.equal(modifierMask(["alt"]), 1);
  assert.equal(modifierMask(["ctrl"]), 2);
  assert.equal(modifierMask(["meta"]), 4);
  assert.equal(modifierMask(["shift"]), 8);
  assert.equal(modifierMask(["Alt", "Shift"]), 9);
  assert.equal(modifierMask(["command"]), 4);
  assert.equal(modifierMask(["something-else"]), 0);
});

test("interpolatePath walks the whole line and lands exactly on the target", () => {
  const points = interpolatePath({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);

  assert.deepEqual(points, [
    { x: 2, y: 0 },
    { x: 4, y: 0 },
    { x: 6, y: 0 },
    { x: 8, y: 0 },
    { x: 10, y: 0 },
  ]);
  assert.deepEqual(points.at(-1), { x: 10, y: 0 });
});

test("interpolatePath never repeats a point on a short drag", () => {
  const points = interpolatePath({ x: 0, y: 0 }, { x: 3, y: 0 }, 3);

  assert.deepEqual(points, [
    { x: 1, y: 0 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
  ]);
  assert.equal(new Set(points.map((p) => `${p.x},${p.y}`)).size, points.length);
});

test("interpolatePath clamps the step count and always yields the target last", () => {
  assert.equal(interpolatePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 500).length, 200);
  assert.equal(interpolatePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0).length, 1);
  assert.deepEqual(interpolatePath({ x: 4, y: 9 }, { x: 40, y: 90 }, 0), [{ x: 40, y: 90 }]);
});
