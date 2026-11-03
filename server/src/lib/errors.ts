// Errors that map to an HTTP status and a message safe to show to the person using the app.
export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500;
  readonly code: string;
  constructor(status: HttpError['status'], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'This request was blocked.') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'That item') => new HttpError(404, 'not_found', `${what} was not found.`);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooMany = (message: string) => new HttpError(429, 'rate_limited', message);
