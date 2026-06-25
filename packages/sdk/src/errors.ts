/**
 * @marchward/sdk — Error classes
 */

/** Base error for all Marchward SDK errors. */
export class MarchwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarchwardError";
  }
}

/** Thrown when the API returns a non-2xx response. */
export class MarchwardApiError extends MarchwardError {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly body: unknown;

  constructor(statusCode: number, errorCode: string, message: string, body?: unknown) {
    super(message);
    this.name = "MarchwardApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.body = body;
  }

  /** True if this is a 401/403 authentication error. */
  get isAuthError(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }

  /** True if this is a 404 not found error. */
  get isNotFound(): boolean {
    return this.statusCode === 404;
  }

  /** True if this is a 429 rate limit error. */
  get isRateLimited(): boolean {
    return this.statusCode === 429;
  }

  /** True if this is a server error (5xx). */
  get isServerError(): boolean {
    return this.statusCode >= 500;
  }
}

/** Thrown when a request times out. */
export class MarchwardTimeoutError extends MarchwardError {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "MarchwardTimeoutError";
  }
}

/** Thrown when all retries are exhausted. */
export class MarchwardRetryError extends MarchwardError {
  public readonly attempts: number;
  public readonly lastError: Error;

  constructor(attempts: number, lastError: Error) {
    super(`Request failed after ${attempts} attempts: ${lastError.message}`);
    this.name = "MarchwardRetryError";
    this.attempts = attempts;
    this.lastError = lastError;
  }
}
