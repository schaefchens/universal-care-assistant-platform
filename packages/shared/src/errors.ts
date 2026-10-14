/**
 * Every error the API returns is `{error: {code, params?}}`. The code is also a message key (`error.<code>` in the
 * catalogs), so the app can speak every error in the person's language without the server choosing words.
 */
export const ERROR_CODES = [
  'bad_request',
  'unauthorised',
  'forbidden',
  'not_found',
  'conflict',
  'gone',
  'too_large',
  'rate_limited',
  'upgrade_required',
  'unavailable',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorBody {
  error: { code: ErrorCode | (string & {}); params?: Record<string, string | number | boolean> };
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorised: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  rate_limited: 429,
  upgrade_required: 426,
  unavailable: 503,
  internal: 500,
};
