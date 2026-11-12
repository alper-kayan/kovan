export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (message = 'Sign in to continue') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (
  message = "Your role in this workspace doesn't allow this. Ask one of its owners if you need it.",
) => new HttpError(403, 'forbidden', message);
export const notFound = (message = "That isn't here any more, or you don't have access to it.") =>
  new HttpError(404, 'not_found', message);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const tooMany = (message: string) => new HttpError(429, 'rate_limited', message);
