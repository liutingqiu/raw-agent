import { clip, displayWidth, pad } from "./term.ts";
import { bold, dim, glyph, inverse, paint, theme } from "./theme.ts";
import type { PermissionMode } from "./commands.ts";

export type SettingsState = {
  contextWindow: number;
  permission: PermissionMode;
  effort?: string;
  showReasoning: boolean;
};

export type SettingRow = {
  key: "permission" | "context" | "effort" | "reasoning";
  label: string;
  choices: { label: string; value: string; active: boolean }[];
};

export type SettingsHit = { row: number; value: string; x1: number; x2: number; y: number };

export function settingsRows(state: SettingsState): SettingRow[] {
  const contexts = [...new Set([32_000, 64_000, 128_000, 200_000, 256_000, 512_000, 1_000_000, 2_000_000, state.contextWindow])]
    .sort((a, b) => a - b);
  const human = (n: number) => n >= 1_000_000 ? `${n / 1_000_000}m` : `${n / 1_000}k`;
  return [
    {
      key: "permission",
      label: "Permission",
      choices: (["auto", "ask", "readonly"] as const).map((value) => ({ label: value, value, active: state.permission === value })),
    },
    {
      key: "context",
      label: "Context window",
      choices: contexts.map((value) => ({ label: human(value), value: String(value), active: state.contextWindow === value })),
    },
    {
      key: "effort",
      label: "Reasoning effort",
      choices: ["default", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
        label: value,
        value,
        active: value === (state.effort ?? "default"),
      })),
    },
    {
      key: "reasoning",
      label: "Show reasoning",
      choices: ["hidden", "shown"].map((value) => ({ label: value, value, active: state.showReasoning === (value === "shown") })),
    },
  ];
}

export function renderSettings(
  state: SettingsState,
  selectedRow: number,
  width: number,
  height: number,
): { lines: string[]; hits: SettingsHit[]; rows: SettingRow[]; closeY: number } {
  width = Math.max(24, width);
  const rows = settingsRows(state);
  const lines: string[] = [
    "",
    paint("  raw settings", bold, theme.info),
    dim("  Click a value, or use ↑/↓ and ←/→. Enter selects; Esc or F2 closes."),
    "",
  ];
  const hits: SettingsHit[] = [];
  const prefixWidth = Math.min(20, Math.max(14, Math.floor(width * 0.27)));

  rows.forEach((row, rowIndex) => {
    let raw = `${rowIndex === selectedRow ? `  ${glyph.arrow}` : "   "} ${row.label}`;
    raw = pad(clip(raw, prefixWidth - 1), prefixWidth);
    let styled = rowIndex === selectedRow ? paint(raw, theme.accent) : dim(raw);
    let x = displayWidth(raw) + 1;

    for (const choice of row.choices) {
      const button = `[ ${choice.label} ]`;
      const needed = displayWidth(button) + 1;
      if (x + needed - 1 > width && x > prefixWidth + 1) {
        lines.push(styled);
        raw = " ".repeat(prefixWidth);
        styled = raw;
        x = prefixWidth + 1;
      }
      const y = lines.length + 1;
      styled += " " + (choice.active ? paint(button, inverse, theme.ok) : paint(button, theme.muted));
      hits.push({ row: rowIndex, value: choice.value, x1: x + 1, x2: x + displayWidth(button), y });
      x += needed;
    }
    lines.push(styled);
    lines.push("");
  });

  const closeY = Math.min(height, lines.length + 1);
  lines.push(paint("  [ Close ]", theme.brand));
  lines.push(dim("  Custom context sizes remain available with /context 750k or --context-window."));
  return { lines: lines.slice(0, Math.max(1, height)), hits: hits.filter((hit) => hit.y <= height), rows, closeY };
}
