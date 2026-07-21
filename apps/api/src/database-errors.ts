const UNIQUE_VIOLATION_CODE = '23505';

export function isUniqueViolation(error: unknown) {
  const errorCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? error.cause
      : undefined;
  const causeCode =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? cause.code
      : undefined;

  return (
    errorCode === UNIQUE_VIOLATION_CODE || causeCode === UNIQUE_VIOLATION_CODE
  );
}
