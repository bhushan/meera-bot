/**
 * Error classification for the whole pipeline.
 *
 * `retryable` drives the retry helpers: transient external failures are retried,
 * validation and authorization failures never are.
 */
export type ErrorKind =
  | 'config'
  | 'validation'
  | 'authorization'
  | 'rate_limit'
  | 'telegram'
  | 'gemini'
  | 'supabase'
  | 'rss'
  | 'timeout'
  | 'internal';

export interface AppErrorOptions {
  kind: ErrorKind;
  message: string;
  retryable?: boolean;
  /** HTTP status to surface when this error reaches an API route. */
  status?: number;
  /** Non-secret structured context for logs. Never put credentials here. */
  context?: Record<string, unknown>;
  cause?: unknown;
}

const DEFAULT_RETRYABLE: Record<ErrorKind, boolean> = {
  config: false,
  validation: false,
  authorization: false,
  rate_limit: false,
  telegram: true,
  gemini: true,
  supabase: true,
  rss: true,
  timeout: true,
  internal: false,
};

const DEFAULT_STATUS: Record<ErrorKind, number> = {
  config: 500,
  validation: 400,
  authorization: 401,
  rate_limit: 429,
  telegram: 502,
  gemini: 502,
  supabase: 502,
  rss: 502,
  timeout: 504,
  internal: 500,
};

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly retryable: boolean;
  readonly status: number;
  readonly context: Record<string, unknown>;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.kind = options.kind;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[options.kind];
    this.status = options.status ?? DEFAULT_STATUS[options.kind];
    this.context = options.context ?? {};
  }
}

export class ConfigValidationError extends AppError {
  readonly invalidKeys: string[];

  constructor(invalidKeys: string[], detail: string) {
    super({
      kind: 'config',
      message: `Invalid or missing configuration: ${detail}`,
      retryable: false,
      context: { invalidKeys },
    });
    this.name = 'ConfigValidationError';
    this.invalidKeys = invalidKeys;
  }
}

export const isAppError = (err: unknown): err is AppError => err instanceof AppError;

export const isRetryable = (err: unknown): boolean =>
  isAppError(err) ? err.retryable : !(err instanceof TypeError || err instanceof SyntaxError);

export const errorKind = (err: unknown): ErrorKind => (isAppError(err) ? err.kind : 'internal');

/** Short, non-secret description safe for logs and for the database `failure_reason` column. */
export const describeError = (err: unknown): string => {
  if (isAppError(err)) return `${err.kind}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `unknown: ${String(err)}`;
};

export const validationError = (message: string, context?: Record<string, unknown>): AppError =>
  new AppError({ kind: 'validation', message, retryable: false, context });

export const authorizationError = (message: string, context?: Record<string, unknown>): AppError =>
  new AppError({ kind: 'authorization', message, retryable: false, context });
