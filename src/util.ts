import path from "node:path";

/* ---------- colors ---------- */
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const c = (n: number, s: string) => (useColor ? `\x1b[${n}m${s}\x1b[0m` : s);
export const dim = (s: string) => c(90, s);
export const bold = (s: string) => c(1, s);
export const cyan = (s: string) => c(36, s);
export const green = (s: string) => c(32, s);
export const yellow = (s: string) => c(33, s);
export const red = (s: string) => c(31, s);

/* ---------- truncation ---------- */
export function truncate(text: string, maxChars: number, label = "chars"): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  const omitted = text.length - maxChars;
  return (
    text.slice(0, head) +
    `\n\n... [${omitted} ${label} omitted] ...\n\n` +
    text.slice(text.length - tail)
  );
}

/* ---------- paths ---------- */
export function resolvePath(p: string, root: string): string {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function rel(root: string, target: string): string {
  const r = path.relative(root, target);
  return r === "" ? "." : r;
}

/* ---------- tiny diff ---------- */
export function diffPreview(oldText: string, newText: string, context = 2, maxLines = 60): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: string[] = [];
  const ctxStart = Math.max(0, start - context);
  for (let i = ctxStart; i < start; i++) out.push("  " + a[i]);
  for (let i = start; i < endA; i++) out.push("- " + a[i]);
  for (let i = start; i < endB; i++) out.push("+ " + b[i]);
  const ctxEnd = Math.min(a.length, endA + context);
  for (let i = endA; i < ctxEnd; i++) out.push("  " + a[i]);
  const body = out.length > maxLines ? [...out.slice(0, maxLines), dim(`... ${out.length - maxLines} more lines`)] : out;
  const removed = endA - start;
  const added = endB - start;
  return body.join("\n") + `\n${dim(`@@ -${start + 1},${removed} +${start + 1},${added} @@`)}`;
}

/* ---------- misc ---------- */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(s.length / 4);
}

export function oneline(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

export function firstLine(s: string, max = 100): string {
  return oneline(s.split("\n")[0] ?? "", max);
}
