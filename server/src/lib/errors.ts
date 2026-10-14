/**
 * Errors the API returns as `{error: {code, params}}`. The code is a message key, so the app speaks it in the
 * person's language. Internal details never leave the server; validation errors never echo the input.
 */
import { type ErrorCode, HTTP_STATUS } from '@ucap/shared';

export class AppError extends Error {
  readonly code: ErrorCode | (string & {});
  readonly status: number;
  readonly params: Record<string, string | number | boolean> | undefined;

  constructor(code: ErrorCode | (string & {}), opts: { status?: number; params?: Record<string, string | number | boolean> } = {}) {
    super(code);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? HTTP_STATUS[code as ErrorCode] ?? 400;
    this.params = opts.params;
  }
}

export const notFound = () => new AppError('not_found');
export const forbidden = () => new AppError('forbidden');
export const unauthorised = () => new AppError('unauthorised');
