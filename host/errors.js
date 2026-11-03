/**
 * Shared diagnostic formatting for Host operations.
 * @module @kuhufu/dsh-mcp-manager/host/errors
 */

/**
 * Render any thrown value, retaining an Error name when its message is empty.
 * @param {unknown} error - thrown value.
 * @returns {string} printable diagnostic.
 */
export function formatError(error) {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return String(error);
}
