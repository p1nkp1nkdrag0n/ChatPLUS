export type LogContext = Readonly<Record<string, unknown>>;

export interface KernelLogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export const noopLogger: KernelLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

export function withLogContext(
  logger: KernelLogger,
  baseContext: LogContext,
): KernelLogger {
  const merge = (context?: LogContext): LogContext => ({
    ...baseContext,
    ...context,
  });
  return {
    debug: (message, context) => logger.debug(message, merge(context)),
    info: (message, context) => logger.info(message, merge(context)),
    warn: (message, context) => logger.warn(message, merge(context)),
    error: (message, context) => logger.error(message, merge(context)),
  };
}
