// Conservative signatures that yt-dlp and gallery-dl emit when a platform
// rejects the stored session cookies. Rate limiting and checkpoint challenges
// are intentionally excluded so temporary throttling is never reported as a
// logout.
const AUTH_FAILURE_PATTERNS = [
  /authenticationerror/i,
  /\b401 unauthorized\b/i,
  /http error 401/i,
  /login required/i,
  /redirect(?:ed)? to (?:the )?login page/i,
  /please log in to/i,
  /not logged in/i,
] as const;

function errorMessages(error: unknown, seen: Set<unknown>): string[] {
  if (seen.has(error)) return [];
  seen.add(error);
  if (typeof error === 'string') return [error];
  if (!(error instanceof Error)) return [];

  const messages = [error.message, ...errorMessages(error.cause, seen)];
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      messages.push(...errorMessages(inner, seen));
    }
  }
  return messages;
}

export function isPlatformAuthFailure(error: unknown) {
  return errorMessages(error, new Set()).some((message) =>
    AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message)),
  );
}
