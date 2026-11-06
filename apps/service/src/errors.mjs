export class ServiceError extends Error {
  constructor(status, code, cause) {
    super(code);
    this.status = status;
    this.code = code;
    // The upstream failure behind a mapped error. Only error monitoring reads it, and only its class and stack frames.
    if (cause !== undefined) this.cause = cause;
  }
}
export function fail(status, code, cause) {
  throw new ServiceError(status, code, cause);
}
