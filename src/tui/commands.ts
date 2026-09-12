/**
 * Slash commands.
 *
 * They are deliberately thin: each one either reports state or calls back into
 * the CLI for anything that needs the model or the running session.
 */
import { bindings, bold, dim, glyph, isMac, isWindows, keyLabel, paint, theme } from "./theme.ts";
import { humanTokens, meter } from "./ui.ts";
import { parseTokenCount, type AgentConfig, type Msg } from "../api.ts";
import { PRESETS, findPreset } from "../presets.ts";
import { CONFIG_FILE, SESSION_DIR, maskKey, readConfig } from "../paths.ts";
import type { ImagePart } from "../tools.ts";

export type PermissionMode = "auto" | "ask" | "readonly";

export const PERMISSION_ORDER: PermissionMode[] = ["auto", "ask", "readonly"];

export const permissionBlurb: Record<PermissionMode, string> = {
  auto: "run everything without asking",
  ask: "confirm every write, command and browser script",
  readonly: "refuse anything that changes state",
};

export type CommandContext = {
  cfg: AgentConfig;
  setConfig: (c: AgentConfig) => void;
  messages: Msg[];
  setMessages: (m: Msg[]) => void;
  permission: PermissionMode;
  setPermission: (p: PermissionMode) => void;
  showReasoning: boolean;
  setShowReasoning: (v: boolean) => void;
  goal: string | null;
  setGoal: (g: string | null) => void;
  sessionFile: string;
  newSession: () => string;
  print: (line?: string) => void;
  width: () => number;
  attach: (image: ImagePart, label: string) => void;
  compact: (instructions?: string) => Promise<void>;
  usage: () => { used: number; total: number; images: number; turns: number };
  exit: () => void;
};

export type Command = {
  name: string;
  args?: string;
  summary: string;
  run: (ctx: CommandContext, arg: string) => Promise<void> | void;
};

/* ------------------------------------------------------------------ *
 * the command table
 * ------------------------------------------------------------------ */

export const commands: Command[] = [
  {
    name: "help",
    args: "[command]",
    summary: "this list, or the full key reference",
    run(ctx, arg) {
      if (arg) {
        const c = commands.find((x) => x.name === arg);
        ctx.print(c ? `${paint("/" + c.name, bold, theme.accent)} ${dim(c.args ?? "")}\n  ${c.summary}` : `no such command: ${arg}`);
        return;
      }
      ctx.print(paint("commands", bold, theme.info));
      for (const c of commands) {
        ctx.print(`  ${paint(("/" + c.name).padEnd(13), theme.accent)}${dim((c.args ?? "").padEnd(16))}${c.summary}`);
      }
      ctx.print("");
      ctx.print(paint(`keys ${dim(`(${isMac ? "macOS" : isWindows ? "Windows" : "Linux"})`)}`, bold, theme.info));
      for (const b of bindings) {
        const keys = isMac ? b.mac : isWindows ? b.win : b.linux;
        ctx.print(`  ${paint(keys.padEnd(22), theme.brandAlt)}${b.what}`);
      }
      ctx.print("");
      ctx.print(dim("  Esc stops generation · text selection copies as usual · Ctrl+G grabs a clipboard image"));
    },
  },

  {
    name: "goal",
    args: "[text | clear]",
    summary: "a standing instruction, sent as your first message every turn",
    run(ctx, arg) {
      if (!arg) {
        ctx.print(ctx.goal ? `${paint("goal", bold)} ${ctx.goal}` : dim("no goal set — /goal <text> to add a standing instruction"));
        return;
      }
      if (arg === "clear" || arg === "none") {
        ctx.setGoal(null);
        ctx.print(dim("goal cleared"));
        return;
      }
      ctx.setGoal(arg);
      ctx.print(`${paint("goal set", theme.ok)} ${dim("— sent as a user message at the start of every turn")}`);
    },
  },

  {
    name: "context",
    args: "[tokens]",
    summary: "inspect or set the context window (for example /context 128k)",
    run(ctx, arg) {
      if (arg) {
        const contextWindow = parseTokenCount(arg);
        if (contextWindow === undefined) {
          ctx.print(paint(`invalid context window "${arg}" — use 128k, 1m, or a token count`, theme.warn));
          return;
        }
        ctx.setConfig({ ...ctx.cfg, contextWindow });
        ctx.print(`${glyph.check} context window ${dim("→")} ${paint(contextWindow.toLocaleString("en-US"), theme.accent)} tokens`);
        return;
      }
      const { used, total, images, turns } = ctx.usage();
      const w = Math.max(20, ctx.width() - 8);
      const byRole: Record<string, { n: number; chars: number }> = {};
      for (const m of ctx.messages) {
        const role = m.role;
        const chars = JSON.stringify(m).length;
        byRole[role] ??= { n: 0, chars: 0 };
        byRole[role].n++;
        byRole[role].chars += chars;
      }
      ctx.print(paint("context", bold, theme.info));
      ctx.print(`  ${meter(used, total, Math.min(24, w - 22))} ${humanTokens(used)} / ${humanTokens(total)} tokens ${dim(`(${((used / total) * 100).toFixed(1)}%)`)}`);
      ctx.print(`  ${ctx.messages.length} messages · ${turns} turns · ${images} image${images === 1 ? "" : "s"}`);
      for (const [role, v] of Object.entries(byRole)) {
        ctx.print(dim(`  ${role.padEnd(10)} ${String(v.n).padStart(3)} msgs  ${humanTokens(Math.round(v.chars / 4))} tokens`));
      }
      if (ctx.goal) ctx.print(dim(`  goal       ${ctx.goal.slice(0, w - 12)}`));
      ctx.print(dim(`  session    ${ctx.sessionFile}`));
    },
  },

  {
    name: "compact",
    args: "[instructions]",
    summary: "summarise older turns into one message and drop the rest",
    async run(ctx, arg) {
      await ctx.compact(arg || undefined);
    },
  },

  {
    name: "model",
    args: "[id]",
    summary: "show or switch the model",
    async run(ctx, arg) {
      if (!arg) {
        const cfg = readConfig();
        const stored = cfg.providers?.[ctx.cfg.provider];
        const preset = findPreset(ctx.cfg.provider);
        const models = [...(stored?.models ?? []), ...(preset?.models.map((m) => m.id) ?? [])].filter(
          (m, i, a) => a.indexOf(m) === i,
        );
        ctx.print(`${paint("model", bold)} ${paint(ctx.cfg.model, theme.accent)} ${dim(`(${ctx.cfg.provider})`)}`);
        if (models.length) {
          ctx.print(dim("  known for this provider:"));
          for (const m of models.slice(0, 24)) {
            const current = m === ctx.cfg.model;
            ctx.print(`  ${current ? paint(glyph.arrow, theme.ok) : " "} ${current ? paint(m, theme.accent) : dim(m)}`);
          }
        }
        ctx.print(dim("  /model <id> to switch · /provider to change provider"));
        return;
      }
      const { resolveConfig } = await import("../api.ts");
      const next = resolveConfig({ provider: ctx.cfg.provider, model: arg });
      ctx.setConfig(next);
      ctx.print(`${glyph.check} model ${dim("→")} ${paint(next.model, theme.accent)}`);
    },
  },

  {
    name: "provider",
    args: "[name]",
    summary: "show or switch provider",
    async run(ctx, arg) {
      if (!arg) {
        const cfg = readConfig();
        const names = Object.keys(cfg.providers ?? {});
        ctx.print(`${paint("provider", bold)} ${paint(ctx.cfg.provider, theme.accent)} ${dim(maskKey(cfg.providers?.[ctx.cfg.provider]?.apiKey))}`);
        if (names.length) ctx.print(dim(`  configured: ${names.join(", ")}`));
        ctx.print(dim(`  presets: ${PRESETS.map((p) => p.id).join(", ")}`));
        ctx.print(dim("  add one with: raw setup"));
        return;
      }
      const stored = readConfig().providers?.[arg];
      if (!stored) {
        ctx.print(paint(`provider "${arg}" is not configured — run raw setup ${arg}`, theme.warn));
        return;
      }
      const { resolveConfig } = await import("../api.ts");
      const next = resolveConfig({ provider: arg });
      if (!next.configured) {
        ctx.print(paint(`provider "${arg}" has no usable model or key — run raw setup ${arg}`, theme.warn));
        return;
      }
      ctx.setConfig(next);
      ctx.print(`${glyph.check} provider ${dim("→")} ${paint(next.provider, theme.accent)}${dim("/")}${paint(next.model, theme.accent)}`);
    },
  },

  {
    name: "effort",
    args: "[minimal|low|medium|high|xhigh|max|off]",
    summary: "reasoning effort for the next turns",
    run(ctx, arg) {
      if (!arg) {
        ctx.print(`${paint("effort", bold)} ${paint(ctx.cfg.reasoningEffort ?? "provider default", theme.accent)}`);
        ctx.print(dim("  /effort minimal | low | medium | high | xhigh | max | off"));
        return;
      }
      if (arg === "off" || arg === "none") {
        ctx.setConfig({ ...ctx.cfg, reasoningEffort: undefined });
        ctx.print(dim("effort cleared (provider default)"));
        return;
      }
      if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(arg)) {
        ctx.print(paint(`unknown effort "${arg}"`, theme.warn));
        return;
      }
      ctx.setConfig({ ...ctx.cfg, reasoningEffort: arg });
      ctx.print(`${glyph.check} effort ${dim("→")} ${paint(arg, theme.accent)}`);
    },
  },

  {
    name: "permission",
    args: "[auto|ask|readonly]",
    summary: "how much the agent may do without asking",
    run(ctx, arg) {
      if (!arg) {
        ctx.print(paint("permission", bold));
        for (const mode of PERMISSION_ORDER) {
          const mark = mode === ctx.permission ? paint(glyph.arrow, theme.ok) : " ";
          ctx.print(`  ${mark} ${paint(mode.padEnd(10), mode === ctx.permission ? theme.ok : undefined)} ${dim(permissionBlurb[mode])}`);
        }
        ctx.print(dim(`  ${keyLabel("permission")} cycles modes`));
        return;
      }
      if (!PERMISSION_ORDER.includes(arg as PermissionMode)) {
        ctx.print(paint(`unknown mode "${arg}" — use ${PERMISSION_ORDER.join(", ")}`, theme.warn));
        return;
      }
      ctx.setPermission(arg as PermissionMode);
      ctx.print(`${glyph.check} permission ${dim("→")} ${paint(arg, theme.accent)} ${dim(permissionBlurb[arg as PermissionMode])}`);
    },
  },

  {
    name: "reasoning",
    args: "[on|off]",
    summary: "show or hide the model's thinking",
    run(ctx, arg) {
      if (!arg) {
        ctx.print(
          `${paint("reasoning", bold)} ${paint(ctx.showReasoning ? "shown" : "hidden", theme.accent)} ` +
            dim("— this changes display only; provider-required reasoning state is preserved"),
        );
        ctx.print(dim("  /reasoning on | off"));
        return;
      }
      const on = arg === "on" || arg === "show" || arg === "true";
      const off = arg === "off" || arg === "hide" || arg === "false";
      if (!on && !off) {
        ctx.print(paint(`expected on or off, got "${arg}"`, theme.warn));
        return;
      }
      ctx.setShowReasoning(on);
      ctx.print(`${glyph.check} reasoning ${dim("→")} ${paint(on ? "shown" : "hidden", theme.accent)}`);
    },
  },

  {
    name: "paste",
    args: "",
    summary: "attach an image from the clipboard to your next message",
    async run(ctx) {
      const { readClipboardImage } = await import("../clipboard.ts");
      const res = readClipboardImage();
      if (!res.ok) {
        ctx.print(paint(`no image: ${res.reason}`, theme.warn));
        if (res.hint) ctx.print(dim(`  ${res.hint}`));
        return;
      }
      ctx.attach(res.image, res.label);
      ctx.print(`${glyph.check} attached ${paint(res.label, theme.accent)} ${dim(`${Math.round((res.image.data.length * 3) / 4 / 1024)} KB`)}`);
    },
  },

  {
    name: "image",
    args: "<path>",
    summary: "attach an image file to your next message",
    async run(ctx, arg) {
      if (!arg) {
        ctx.print(dim("usage: /image <path>"));
        return;
      }
      const { readImageFile } = await import("../clipboard.ts");
      const res = readImageFile(arg);
      if (!res.ok) {
        ctx.print(paint(`cannot attach: ${res.reason}`, theme.warn));
        return;
      }
      ctx.attach(res.image, res.label);
      ctx.print(`${glyph.check} attached ${paint(res.label, theme.accent)}`);
    },
  },

  {
    name: "tools",
    args: "",
    summary: "list the tools this build exposes",
    async run(ctx) {
      const { toolSpecs } = await import("../tools.ts");
      ctx.print(paint(`tools ${dim(`(${toolSpecs.length})`)}`, bold, theme.info));
      for (const t of toolSpecs) {
        ctx.print(`  ${paint(t.name.padEnd(12), theme.accent)}${t.readOnly ? dim("read-only ") : "          "}${dim(t.description.split(". ")[0])}`);
      }
    },
  },

  {
    name: "notes",
    args: "[key]",
    summary: "what the agent has written down for itself",
    async run(ctx, arg) {
      const { runTool } = await import("../tools.ts");
      const result = await runTool("notes", arg ? { action: "read", key: arg } : { action: "list" }, {
        root: process.cwd(),
        allowOutside: false,
      });
      ctx.print(typeof result === "string" ? result : result.text);
    },
  },

  {
    name: "session",
    args: "",
    summary: "where this conversation is stored",
    run(ctx) {
      ctx.print(`${paint("session", bold)} ${ctx.sessionFile}`);
      ctx.print(dim(`  sessions dir: ${SESSION_DIR}`));
      ctx.print(dim(`  config:       ${CONFIG_FILE}`));
    },
  },

  {
    name: "new",
    args: "",
    summary: "forget the conversation and start over",
    run(ctx) {
      const file = ctx.newSession();
      ctx.print(dim(`new session: ${file}`));
    },
  },

  { name: "exit", args: "", summary: "leave (same as Ctrl+D on an empty line)", run: (ctx) => ctx.exit() },
];

/* aliases */
const aliases: Record<string, string> = { "?": "help", h: "help", q: "exit", quit: "exit", permissions: "permission", tokens: "context" };

export function findCommand(name: string): Command | undefined {
  const key = aliases[name] ?? name;
  return commands.find((c) => c.name === key);
}

export function commandCompletions(prefix: string) {
  return commands
    .filter((c) => c.name.startsWith(prefix))
    .map((c) => ({ value: "/" + c.name, hint: c.args ? `${c.args} — ${c.summary}` : c.summary }));
}

/* ------------------------------------------------------------------ *
 * help text used by --help (non-interactive)
 * ------------------------------------------------------------------ */

export function keyReference(): string {
  const keys = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
  const rows = bindings.map((b) => {
    const k = isMac ? b.mac : isWindows ? b.win : b.linux;
    return `  ${k.padEnd(22)}${b.what}`;
  });
  return [`${paint(`keys (${keys})`, bold, theme.info)}`, ...rows].join("\n");
}
