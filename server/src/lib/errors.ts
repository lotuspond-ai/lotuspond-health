// Errors that map to an HTTP status and a message safe to show to the person using the app.
export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503;
  readonly code: string;
  /** Extra fields for the client, sent next to code and message (for example where to sign in instead). */
  readonly details?: Record<string, unknown>;
  constructor(status: HttpError['status'], code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'This request was blocked.') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'That item') => new HttpError(404, 'not_found', `${what} was not found.`);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooMany = (message: string) => new HttpError(429, 'rate_limited', message);
