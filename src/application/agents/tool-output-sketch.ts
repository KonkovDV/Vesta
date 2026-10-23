/**
 * Oversized tool results for the agent journal.
 * Layer: Application
 *
 * Open GigaAgent (ai-forever/giga_agent) does not paste a huge tool payload
 * into the next model turn. It keeps the value in the REPL and sends a schema
 * plus a pointer. This journal has a fixed character budget, so the same idea
 * is a schema and a pointer. When the full text is already in a file, the
 * journal does not also keep a long head.
 */

import { TOOL_OUTPUT_CHAR_LIMIT } from '../../core/events/agent-run.schemas';

const SKETCH_CHAR_LIMIT = 4_000;

export function toolOutputText(value: unknown): string {
  return typeof value === 'string' ? value : stringify(value);
}

export function presentToolOutput(
  value: unknown,
  limit: number = TOOL_OUTPUT_CHAR_LIMIT,
  spillPath?: string | null,
): string {
  const text = toolOutputText(value);
  if (text.length <= limit) {
    return text;
  }

  const sketch = buildSketch(text).slice(0, SKETCH_CHAR_LIMIT);
  const pointer = spillPath
    ? `Полный текст записан в файл ${spillPath}. Читай его через read_file: offset — номер строки с нуля, limit не больше 400.`
    : 'Хвост не сохранён: рабочий каталог пуст. Сузь аргументы инструмента.';
  const notice = [
    `Результат не помещается в журнал: ${text.length} символов.`,
    pointer,
    spillPath ? 'Ниже только схема. Начала текста в журнале нет.' : 'Ниже схема и начало.',
    sketch,
    '',
  ].join('\n');

  if (spillPath || notice.length >= limit) {
    return notice.slice(0, limit);
  }
  return notice + text.slice(0, limit - notice.length);
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildSketch(text: string): string {
  const parsed = parseJson(text);
  if (parsed === undefined) {
    const lines = text.split('\n');
    return `текст, строк: ${lines.length}`;
  }
  return `json ${describe(parsed)}`;
}

function parseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const head = value.length > 0 ? describe(value[0]) : 'пусто';
    return `массив из ${value.length}, первый элемент: ${head}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    const fields = entries.map(([key, item]) => `${key}: ${describe(item)}`);
    const extra = Object.keys(value).length - entries.length;
    const suffix = extra > 0 ? `, ещё полей: ${extra}` : '';
    return `объект { ${fields.join(', ')}${suffix} }`;
  }
  if (typeof value === 'string') return `строка ${value.length}`;
  if (typeof value === 'number' || typeof value === 'boolean') return typeof value;
  return typeof value;
}
