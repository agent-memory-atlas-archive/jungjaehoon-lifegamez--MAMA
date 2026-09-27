/** Telegram 4xx responses reject the operation; transport and 5xx errors may follow a send. */
export function isDefinitiveTelegramRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('error_code' in error)) return false;
  return typeof error.error_code === 'number' && error.error_code >= 400 && error.error_code < 500;
}
