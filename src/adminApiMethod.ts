/** Admin settings and decisions use PATCH; OTP endpoints explicitly use POST. */
export function adminApiMethod(path:string, hasBody:boolean): 'GET'|'POST'|'PATCH' {
  if (!hasBody) return 'GET';
  return path.startsWith('/api/v1/auth/otp/') ? 'POST' : 'PATCH';
}
