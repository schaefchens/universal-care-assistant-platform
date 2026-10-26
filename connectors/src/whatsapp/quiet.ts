/**
 * What Baileys and libsignal may write, kept from the WhatsApp process's output (docs/plan-m3.md, K2 and K9).
 *
 * - Baileys' logger writes nothing: at its debug and trace levels it passes frames, ids and content. Warnings and
 *   errors are only counted, by their wording (ids and digits blanked).
 * - libsignal, under Baileys, prints whole session records with their private keys through the console ("Closing
 *   session: SessionEntry {…}", spike A), past Baileys' logger. Importing this module replaces the console, so the
 *   process imports it before Baileys; its lines are counted by their first words.
 *
 * `lastHour()` is the hourly line of what was counted: wording only. The log canary (connectors/test/log-canary.test.ts)
 * runs this with Baileys at its loudest level.
 */

const warnings = new Map<string, number>();
const consoleLines = new Map<string, number>();

for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir'] as const) {
  console[m] = (...args: unknown[]) => {
    const first = typeof args[0] === 'string' ? args[0] : `‹${typeof args[0]}›`;
    const key = first.replace(/\S*@\S*/g, '<jid>').replace(/\d+/g, '#').slice(0, 40);
    consoleLines.set(key, (consoleLines.get(key) ?? 0) + 1);
  };
}

const count = (obj: unknown, msg?: string) => {
  const text = typeof obj === 'string' ? obj : (msg ?? 'unnamed');
  const key = text.replace(/\S*@\S*/g, '<jid>').replace(/\d+/g, '#').slice(0, 80);
  warnings.set(key, (warnings.get(key) ?? 0) + 1);
};

export interface Logger {
  level: string;
  child(obj: Record<string, unknown>): Logger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Baileys' logger: nothing written; warnings and errors counted by their wording, for the hourly line. */
export const logger: Logger = { level: 'warn', child: () => logger, trace: () => {}, debug: () => {}, info: () => {}, warn: count, error: count };

/** What Baileys and libsignal wanted to write since the last call, by wording, or null when nothing. */
export function lastHour(): string | null {
  const all = [...warnings, ...[...consoleLines].map(([k, n]) => [`console: ${k}`, n] as const)];
  warnings.clear();
  consoleLines.clear();
  return all.length ? `last hour: ${all.map(([k, n]) => `${n}× "${k}"`).join(', ')}` : null;
}
