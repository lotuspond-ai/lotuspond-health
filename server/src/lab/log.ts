// Structured logging. Fields carry ids only: never request bodies, names, phone numbers or result values
// (design doc §12). `alert: true` marks lines monitoring should page on.
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const line = (msg: string, fields?: LogFields) => `[lab] ${msg}${fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`;

/** "[lab] message {fields}" lines, in the style of the rest of the server's logs. */
export const consoleLogger: Logger = {
  info: (msg, fields) => console.log(line(msg, fields)),
  warn: (msg, fields) => console.warn(line(msg, fields)),
  error: (msg, fields) => console.error(line(msg, fields)),
};

export interface LogLine { level: 'info' | 'warn' | 'error'; msg: string; fields: LogFields }

/** Keeps lines in memory; for tests. */
export function memoryLogger(): Logger & { lines: LogLine[]; alerts(): LogLine[] } {
  const lines: LogLine[] = [];
  const at = (level: LogLine['level']) => (msg: string, fields: LogFields = {}) => { lines.push({ level, msg, fields }); };
  return { lines, info: at('info'), warn: at('warn'), error: at('error'), alerts: () => lines.filter(l => l.fields.alert === true) };
}
