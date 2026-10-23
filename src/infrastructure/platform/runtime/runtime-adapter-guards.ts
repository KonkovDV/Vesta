type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

export function isDisposable(value: unknown): value is { dispose: () => void } {
  return isRecord(value) && typeof value.dispose === 'function';
}

export function disposeIfDisposable(value: unknown): void {
  if (!isDisposable(value)) {
    return;
  }

  value.dispose();
}

export function hasSetOption(
  value: unknown,
): value is { setOption: (key: string, next: unknown) => void } {
  return isRecord(value) && typeof value.setOption === 'function';
}

export function setOptionIfSupported(value: unknown, key: string, next: unknown): void {
  if (!hasSetOption(value)) {
    return;
  }

  value.setOption(key, next);
}

export function getHoveredLinkText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const link = value.currentHoveredLink;
  if (!isRecord(link)) {
    return undefined;
  }

  return typeof link.text === 'string' ? link.text : undefined;
}

export function getSpeechRecognitionCtor<T>(value: unknown): (new () => T) | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const ctor =
    typeof value.webkitSpeechRecognition === 'function'
      ? value.webkitSpeechRecognition
      : value.SpeechRecognition;

  if (typeof ctor !== 'function') {
    return undefined;
  }

  return ctor as new () => T;
}