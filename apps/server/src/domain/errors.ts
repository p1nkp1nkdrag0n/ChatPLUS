export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(kind: string): ApiError {
  return new ApiError(404, "not_found", `${kind} was not found.`);
}
