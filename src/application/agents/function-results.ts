/**
 * Addressable tool results for the next model turn.
 * Layer: Application
 *
 * GigaAgent keeps every tool payload in function_results and, when the model
 * writes code in the assistant text instead of the tool arguments, reads that
 * fenced block. The journal stays bounded. The index is the pointer.
 */

import type { ChatMessage } from '../../domain/ai/IChatCompletionModel';

export const FUNCTION_RESULTS_MARK = 'function_results index';
const MAX_RECOVERED_COMMAND = 8_000;
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh']);
const PYTHON_LANGUAGES = new Set(['python', 'py']);
const SHELL_FENCE = /```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g;
const SHELL_LANGUAGES = new Set(['', 'bash', 'sh', 'shell', 'powershell', 'pwsh', 'cmd']);

export interface FunctionResultEntry {
  index: number;
  name: string;
  chars: number;
  file: string | null;
}

export function functionResultHeader(entry: FunctionResultEntry): string {
  const file = entry.file ? ` file=${entry.file}` : '';
  return `function_results[${entry.index}] ${entry.name} chars=${entry.chars}${file}`;
}

export function readFunctionResultHeader(output: string): FunctionResultEntry | null {
  const line = output.split('\n', 1)[0] ?? '';
  const match = /^function_results\[(\d+)\] (\S+) chars=(\d+)(?: file=(.*))?$/.exec(line);
  if (!match) return null;
  return {
    index: Number(match[1]),
    name: match[2] ?? '',
    chars: Number(match[3]),
    file: match[4] && match[4].length > 0 ? match[4] : null,
  };
}

export function functionResultsCatalog(entries: readonly FunctionResultEntry[]): string | null {
  if (entries.length === 0) return null;
  return [
    FUNCTION_RESULTS_MARK,
    'Ответы инструментов этого прогона. Если указан file, в журнале только схема: полный текст читай через read_file (offset с нуля, limit не больше 400). Сводка для оболочки лежит в index.txt рядом с этими файлами. Команда оболочки начинается заново: состояние между вызовами сохраняй файлом в рабочем каталоге.',
    ...entries.map(functionResultHeader),
  ].join('\n');
}

export function withFunctionResultsCatalog(
  messages: readonly ChatMessage[],
  entries: readonly FunctionResultEntry[],
): ChatMessage[] {
  const kept = messages.filter(
    (message) => !(message.role === 'system' && message.content.startsWith(FUNCTION_RESULTS_MARK)),
  );
  const catalog = functionResultsCatalog(entries);
  if (!catalog) return kept;
  return [...kept, { role: 'system', content: catalog }];
}

/** Shell command or Python source, taken from a fence only when the tool was already requested. */
export function recoverToolArguments(
  toolName: string,
  argumentsJson: string,
  assistantContent: string | undefined,
): string {
  const name = toolName.trim().toLowerCase();
  if (SHELL_TOOLS.has(name)) return recoverEmptyShellCommand(name, argumentsJson, assistantContent);
  if (name === 'python') return recoverEmptyPythonCode(argumentsJson, assistantContent);
  return argumentsJson;
}

/**
 * Fills an empty shell command from the assistant's own fenced block.
 * A command that is already present stays unchanged. Other tools are unchanged.
 */
export function recoverEmptyShellCommand(
  toolName: string,
  argumentsJson: string,
  assistantContent: string | undefined,
): string {
  if (!SHELL_TOOLS.has(toolName.trim().toLowerCase())) return argumentsJson;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return argumentsJson;
    parsed = value as Record<string, unknown>;
  } catch {
    return argumentsJson;
  }
  const command = typeof parsed.command === 'string' ? parsed.command.trim() : '';
  const unwrapped = unwrapWholeFence(command);
  if (unwrapped) return JSON.stringify({ ...parsed, command: unwrapped });
  if (command.length > 0) return argumentsJson;
  const recovered = firstShellFence(assistantContent);
  if (!recovered) return argumentsJson;
  return JSON.stringify({ ...parsed, command: recovered });
}

function recoverEmptyPythonCode(argumentsJson: string, assistantContent: string | undefined): string {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return argumentsJson;
    parsed = value as Record<string, unknown>;
  } catch {
    return argumentsJson;
  }
  const code = typeof parsed.code === 'string' ? parsed.code.trim() : '';
  const unwrapped = unwrapFence(code, PYTHON_LANGUAGES);
  if (unwrapped) return JSON.stringify({ ...parsed, code: unwrapped });
  if (code.length > 0) return argumentsJson;
  const recovered = firstFence(assistantContent, PYTHON_LANGUAGES);
  if (!recovered) return argumentsJson;
  return JSON.stringify({ ...parsed, code: recovered });
}

function unwrapWholeFence(command: string): string | null {
  return unwrapFence(command, SHELL_LANGUAGES);
}

function unwrapFence(command: string, languages: ReadonlySet<string>): string | null {
  const match = /^```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```$/.exec(command.trim());
  if (!match) return null;
  const language = (match[1] ?? '').toLowerCase();
  if (!languages.has(language)) return null;
  const body = (match[2] ?? '').trim();
  if (body.length === 0 || body.length > MAX_RECOVERED_COMMAND) return null;
  return body;
}

function firstShellFence(content: string | undefined): string | null {
  return firstFence(content, SHELL_LANGUAGES);
}

function firstFence(content: string | undefined, languages: ReadonlySet<string>): string | null {
  if (!content) return null;
  for (const match of content.matchAll(SHELL_FENCE)) {
    const language = (match[1] ?? '').toLowerCase();
    if (!languages.has(language)) continue;
    const body = (match[2] ?? '').trim();
    if (body.length === 0 || body.length > MAX_RECOVERED_COMMAND) continue;
    return body;
  }
  return null;
}
