/**
 * Structured JSON logging.
 *
 * Every line is a single JSON object on stdout/stderr so Vercel's log drain can
 * index it. Nothing that looks like a credential ever survives {@link redact}.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export type LogSink = (line: string) => void;

const SENSITIVE_KEY = /(token|secret|key|password|passwd|authorization|auth|credential|cookie)/i;

/** `bot<digits>:<token>` inside a URL, and bare `<digits>:<token>` in free text. */
const BOT_TOKEN_IN_URL = /bot\d{6,20}:[A-Za-z0-9_-]{30,}/g;
const BARE_BOT_TOKEN = /\b\d{6,20}:[A-Za-z0-9_-]{30,}\b/g;

const REDACTED = '[redacted]';

function redactString(value: string): string {
  return value.replace(BOT_TOKEN_IN_URL, 'bot<redacted>').replace(BARE_BOT_TOKEN, REDACTED);
}

/**
 * Deep-copy `value`, masking sensitive keys and token-shaped strings.
 * Cycle-safe; returns a plain structure that is always JSON-serialisable.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...('kind' in value ? { kind: (value as { kind: unknown }).kind } : {}),
      ...('retryable' in value ? { retryable: (value as { retryable: unknown }).retryable } : {}),
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => redact(item, seen));

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, seen);
    }
    return out;
  }

  return String(value);
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(context: LogFields = {}, sink: LogSink = stdoutSink): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields) => {
    let line: string;
    try {
      line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        ...(redact({ ...context, ...fields }) as LogFields),
      });
    } catch {
      // Logging must never take down a request.
      line = JSON.stringify({
        time: new Date().toISOString(),
        level,
        event,
        logSerializationFailed: true,
      });
    }
    sink(line);
  };

  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => createLogger({ ...context, ...fields }, sink),
  };
}

export const rootLogger = createLogger({ service: 'meera-bot' });
