interface ResultLike {
  isErr(): boolean;
  error?: unknown;
}

/**
 * Retries a Result-returning async call (the @dust-tt/client Ok/Err
 * pattern used throughout this codebase) with exponential backoff,
 * instead of surfacing the first transient failure straight to the user.
 * Returns the last (still-failed) result if every attempt fails.
 *
 * Retries happen silently otherwise - `onRetry` (called right before each
 * retry, i.e. `maxAttempts - 1` times at most) is the hook for surfacing
 * that in the UI, since a retry that only ever shows up in the debug log
 * is easy to mistake for "it didn't retry at all".
 */
export async function retryResult<R extends ResultLike>(
  fn: () => Promise<R>,
  maxAttempts = 5,
  baseDelayMs = 500,
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void
): Promise<R> {
  let result = await fn();
  for (let attempt = 2; attempt <= maxAttempts && result.isErr(); attempt++) {
    onRetry?.(attempt, maxAttempts, result.error);
    await new Promise((resolve) =>
      setTimeout(resolve, baseDelayMs * 2 ** (attempt - 2))
    );
    result = await fn();
  }
  return result;
}
