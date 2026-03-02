function toReadableErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === '[object Object]') {
      return null;
    }
    return trimmed;
  }

  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return toReadableErrorMessage(record.message) || toReadableErrorMessage(record.error);
  }

  return null;
}

export async function parseApiErrorMessage(
  response: Response,
  fallbackByStatus: (status: number) => string
): Promise<string> {
  const fallback = fallbackByStatus(response.status);
  let rawText = '';

  try {
    rawText = await response.text();
  } catch {
    return fallback;
  }

  if (!rawText.trim()) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(rawText) as unknown;
    return toReadableErrorMessage(parsed) || fallback;
  } catch {
    return toReadableErrorMessage(rawText) || fallback;
  }
}
