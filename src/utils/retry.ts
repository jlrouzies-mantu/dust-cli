interface ResultLike {
  isErr(): boolean;
}

/**
 * Retries a Result-returning async call (the @dust-tt/client Ok/Err
 * pattern used throughout this codebase) with exponential backoff,
 * instead of surfacing the first transient failure straight to the user.
 * Returns the last (still-failed) result if every attempt fails.
 */
export async function retryResult<R extends ResultLike>(
  fn: () => Promise<R>,
  maxAttempts = 5,
  baseDelayMs = 500
): Promise<R> {
  let result = await fn();
  for (let attempt = 2; attempt <= maxAttempts && result.isErr(); attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, baseDelayMs * 2 ** (attempt - 2))
    );
    result = await fn();
  }
  return result;
}
