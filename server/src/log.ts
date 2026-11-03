// Structured logging. Fields carry ids only: never request bodies, names, phone numbers or result values
// (design doc §12). `alert: true` marks lines monitoring should page on.
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** One JSON object per line on stdout/stderr. */
export const consoleLogger: Logger = {
  info: (msg, fields) => console.log(JSON.stringify({ level: 'info', msg, ...fields })),
  warn: (msg, fields) => console.warn(JSON.stringify({ level: 'warn', msg, ...fields })),
  error: (msg, fields) => console.error(JSON.stringify({ level: 'error', msg, ...fields })),
};

export interface LogLine { level: 'info' | 'warn' | 'error'; msg: string; fields: LogFields }

/** Keeps lines in memory; for tests. */
export function memoryLogger(): Logger & { lines: LogLine[]; alerts(): LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (msg: string, fields: LogFields = {}) => { lines.push({ level, msg, fields }); };
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), alerts: () => lines.filter(l => l.fields.alert === true) };
}
