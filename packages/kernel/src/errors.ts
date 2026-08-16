export type KernelErrorCode =
  | "duplicate_service"
  | "service_not_found"
  | "invalid_service_token"
  | "duplicate_plugin"
  | "invalid_plugin_manifest"
  | "plugin_dependency_missing"
  | "plugin_dependency_cycle"
  | "plugin_provides_mismatch"
  | "plugin_activation_failed"
  | "plugin_disposal_failed"
  | "actor_queue_closed";

export class KernelError extends Error {
  public override readonly name: string = "KernelError";

  public constructor(
    public readonly code: KernelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DuplicateServiceError extends KernelError {
  public override readonly name = "DuplicateServiceError";

  public constructor(public readonly serviceId: string) {
    super("duplicate_service", `Service "${serviceId}" is already registered`);
  }
}

export class ServiceNotFoundError extends KernelError {
  public override readonly name = "ServiceNotFoundError";

  public constructor(public readonly serviceId: string) {
    super("service_not_found", `Service "${serviceId}" is not registered`);
  }
}

export class PluginDependencyError extends KernelError {
  public override readonly name = "PluginDependencyError";

  public constructor(
    code: "plugin_dependency_missing" | "plugin_dependency_cycle",
    message: string,
    public readonly pluginIds: readonly string[],
  ) {
    super(code, message);
  }
}

export class PluginActivationError extends KernelError {
  public override readonly name = "PluginActivationError";

  public constructor(
    public readonly pluginId: string,
    cause: unknown,
    public readonly rollbackErrors: readonly unknown[] = [],
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      "plugin_activation_failed",
      `Plugin "${pluginId}" failed to activate: ${message}`,
      {
        cause,
      },
    );
  }
}

export class PluginDisposalError extends KernelError {
  public override readonly name = "PluginDisposalError";

  public constructor(
    public readonly failures: readonly { pluginId: string; error: unknown }[],
  ) {
    super(
      "plugin_disposal_failed",
      `Failed to dispose ${failures.length} plugin${failures.length === 1 ? "" : "s"}`,
    );
  }
}
