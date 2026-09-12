import type { AgentConfig, Msg } from "./api.ts";
import { estimateTokens, truncate } from "./util.ts";

/** Drop old image payloads while leaving an explicit marker in the transcript. */
export function stripImages(messages: Msg[], keepLast: number): Msg[] {
  const cutoff = messages.length - keepLast;
  return messages.map((m, i) =>
    m.role !== "assistant" && m.images?.length && i < cutoff
      ? { ...m, images: undefined, content: `${m.content}\n[${m.images.length} image(s) dropped from history]` }
      : m,
  );
}

export function estimateMessages(messages: Msg[]): number {
  let images = 0;
  const light = messages.map((m) => {
    if (m.role !== "assistant" && m.images?.length) {
      images += m.images.length;
      return { ...m, images: m.images.map(() => ({ mime: "image", data: "<image>" })) };
    }
    return m;
  });
  return estimateTokens(light) + images * 900;
}

/** Build the exact messages sent to a provider without introducing a system role. */
export function prune(
  messages: Msg[],
  cfg: Pick<AgentConfig, "contextWindow">,
  goal: string | null,
  dropImages: boolean,
): { messages: Msg[]; dropped: number } {
  const limit = Math.floor(cfg.contextWindow * 0.6);
  // A pasted goal must not consume the entire request budget by itself.
  const boundedGoal = goal ? truncate(goal, Math.max(1_000, Math.floor(limit * 1.5))) : null;
  const trimmed = dropImages
    ? messages.map((m) =>
        m.role !== "assistant" && m.images?.length
          ? { ...m, images: undefined, content: `${m.content}\n[${m.images.length} image(s) omitted]` }
          : m,
      )
    : stripImages(messages, 4);
  const withGoal = (list: Msg[]): Msg[] =>
    boundedGoal ? [{ role: "user", content: `goal: ${boundedGoal}` }, ...list] : list;

  if (estimateMessages(withGoal(trimmed)) <= limit) return { messages: withGoal(trimmed), dropped: 0 };

  const starts: number[] = [];
  trimmed.forEach((m, i) => {
    if (m.role === "user" && i > 0) starts.push(i);
  });
  for (const k of starts) {
    const slice = trimmed.slice(k);
    if (estimateMessages(withGoal(slice)) <= limit) return { messages: withGoal(slice), dropped: k };
  }
  const last = starts.length ? starts[starts.length - 1] : 0;
  // The newest user turn can itself be too large (for example, one assistant
  // emits many tool calls whose outputs are all substantial). Keep every
  // protocol entry and call id, but progressively shorten textual payloads so
  // the next request has a realistic chance of fitting upstream limits.
  let latest = stripImages(trimmed.slice(last), 0);
  for (const cap of [8_000, 2_000, 500]) {
    latest = latest.map((message) => {
      if (message.role === "tool") return { ...message, content: truncate(message.content, cap) };
      if (message.role === "assistant") return { ...message, content: truncate(message.content, cap * 2) };
      return { ...message, content: truncate(message.content, cap * 4) };
    });
    if (estimateMessages(withGoal(latest)) <= limit) return { messages: withGoal(latest), dropped: last };
  }
  return { messages: withGoal(latest), dropped: last };
}

/** Return a user-turn boundary so manual compaction never splits a tool exchange. */
export function compactionBoundary(messages: Msg[], keepUserTurns = 2): number {
  const starts = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  if (starts.length <= keepUserTurns) return 0;
  return starts[starts.length - keepUserTurns];
}
