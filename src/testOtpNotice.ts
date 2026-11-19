/**
 * An environment with no SMS provider can be walked only if the code the server just created is
 * readable somewhere, so `POST /auth/otp/request` echoes it back as `testCode` when — and only when —
 * `JETINO_ALLOW_TEST_OTP=yes` is set on the server without a Kavenegar key. Every login box shows that
 * code through this one function: production responses carry no `testCode`, so the ordinary
 * «کد پیامک می‌شود» note stays and nothing hints at a shortcut.
 */
export function otpRequestNotice(data: unknown, fallback: string): string {
  const code = (data as { testCode?: unknown } | null | undefined)?.testCode;
  return typeof code === 'string' && /^\d{6}$/.test(code) ? `کد آزمایشی این محیط: ${code}` : fallback;
}
