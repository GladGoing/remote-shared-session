export class ServiceError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export function requireThat(condition, status = 400, code = 'invalid_request') {
  if (!condition) throw new ServiceError(status, code);
}
export function text(value, max = 1000) {
  requireThat(typeof value === 'string' && value.length > 0 && value.length <= max);
  return value;
}
export function exactKeys(value, allowed) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).every(key => allowed.includes(key)));
}
