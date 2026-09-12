/**
 * Line input. TTY uses readline (editing + history); piped stdin uses a queue
 * that keeps answers available even after EOF closes the pipe.
 */
import readline from "node:readline/promises";
import { Writable } from "node:stream";

export type Asker = {
  question(prompt: string): Promise<string>;
  /** Read sensitive input without echoing it in an interactive terminal. */
  secret(prompt: string): Promise<string>;
  atEof(): boolean;
  close(): void;
};

export function makeAsker(): Asker {
  if (process.stdin.isTTY) {
    let muted = false;
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
        callback();
      },
    });
    // Setup prompts do not benefit from history, and keeping it disabled also
    // guarantees that a secret answer is not retained by readline.
    const rl = readline.createInterface({ input: process.stdin, output, historySize: 0, terminal: true });
    let eof = false;
    rl.on("close", () => {
      eof = true;
    });
    return {
      question: (q) => rl.question(q).catch(() => ""),
      async secret(prompt) {
        process.stdout.write(prompt);
        muted = true;
        try {
          return await rl.question("").catch(() => "");
        } finally {
          muted = false;
          process.stdout.write("\n");
        }
      },
      atEof: () => eof,
      close: () => rl.close(),
    };
  }

  let buf = "";
  const queue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let eof = process.stdin.readableEnded;

  const deliver = (line: string) => {
    const w = waiters.shift();
    if (w) w(line);
    else queue.push(line);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      deliver(buf.slice(0, i).replace(/\r$/, ""));
      buf = buf.slice(i + 1);
    }
  });
  process.stdin.on("end", () => {
    if (buf) deliver(buf);
    buf = "";
    eof = true;
    while (waiters.length) waiters.shift()!("");
  });
  process.stdin.resume();

  return {
    question(prompt: string) {
      process.stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (eof) return Promise.resolve("");
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    secret(prompt: string) {
      // Piped input is already non-interactive and cannot be echoed by us.
      process.stdout.write(prompt);
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (eof) return Promise.resolve("");
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    atEof: () => eof && queue.length === 0,
    close: () => process.stdin.pause(),
  };
}

export const isYes = (s: string) => /^(y|yes)$/i.test(s.trim());

/** Numbered menu; returns the chosen item or undefined when input ends. */
export async function choose<T>(ask: Asker, items: T[], label: (item: T, i: number) => string, prompt = "select"): Promise<T | undefined> {
  if (!items.length) return undefined;
  items.forEach((item, i) => console.log(`  ${String(i + 1).padStart(3)}. ${label(item, i)}`));
  for (;;) {
    const answer = (await ask.question(`  ${prompt} [1-${items.length}] (or a name): `)).trim();
    if (!answer) {
      if (ask.atEof()) return undefined;
      continue;
    }
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
    const named = items.find((item, i) => label(item, i).trim().toLocaleLowerCase() === answer.toLocaleLowerCase());
    return named; // caller treats any unmatched answer as free text
  }
}
