/**
 * The `ErrCode` a refused till operation carries, read from the one place it survives the bridge.
 *
 * Electron's contextBridge copies a rejected `Error` into the page with its `message` and nothing else, so a
 * `code` property set in the preload is gone by the time a `catch` here sees the error. The preload
 * (`apps/desktop/src/preload-pos.ts`) therefore writes the code at the head of the message as `ERR_…: detail`,
 * and this reads it from there and from nowhere else — a test bridge that kept the property would otherwise
 * pass while the packaged till lost the code.
 */
export function tillErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\b(ERR_[A-Z0-9_]+): /.exec(message)?.[1] ?? null;
}
