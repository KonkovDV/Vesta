import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type { ILogger } from '../../../core/decorators/ILogger';
import type {
  PythonSkillSecurityMetrics,
  PythonSkillSecurityViolationReason,
} from '../../../monitoring';
import { PythonExecutionError, SecurityError } from '../../../domain/errors/DomainError';
import { getRawEnv } from '../../../config';
import { safeJsonParse } from '../../../core/utils/json';

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_ARG_LENGTH = 1000;
const MAX_ARGS_COUNT = 32;
const MAX_ENV_VALUE_LENGTH = 1024;

const ALLOWED_SCRIPTS: ReadonlySet<string> = new Set<string>([
  'analyze.py',
  'simulate.py',
  'search_works.py',
  'fetch_trials.py',
]);

const FORBIDDEN_ARG_CHARS: ReadonlyArray<string> = [
  ';',
  '&',
  '|',
  '`',
  '$',
  '(',
  ')',
  '<',
  '>',
  '{',
  '}',
  '[',
  ']',
  '\\',
];

const ALLOWED_ENV_KEYS: ReadonlyArray<string> = [
  'SKILL_MODE',
  'SKILL_DATASET',
  'SKILL_API_KEY',
];

export interface PythonSkillResult<TData = unknown> {
  success: boolean;
  output: string;
  error?: string;
  data?: TData;
}

export interface PythonSkillOptions {
  skillName: string;
  scriptPath: string; // Relative to the skill directory
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface PythonSkillBridgeConfig {
  skillsRoot?: string;
  /**
   * Имя бинаря Python-рантайма.
   * По умолчанию используется "uv" с префиксом аргументов ["run", "python"].
   */
  pythonBinary?: string;
  /**
   * Префикс аргументов для запуска Python-скрипта.
   * Например: ["run", "python"] для "uv" или [] для прямого "python".
   */
  pythonArgsPrefix?: ReadonlyArray<string>;
  /**
   * Логгер, совместимый с core ILogger, используется для audit-логирования
   * security-отказов в PythonSkillBridge.
   */
  logger?: ILogger;
  /**
   * Метрики безопасности Python skills, инкрементируются при каждом SecurityError.
   */
  securityMetrics?: PythonSkillSecurityMetrics;
  /**
   * Максимальное число параллельных Python-процессов.
   * Если не задано или некорректно, используется безопасный дефолт.
   */
  maxConcurrentProcesses?: number;
}

/**
 * Санитизация аргументов Python-скрипта.
 *
 * Блокирует shell-метасимволы и ограничивает длину/количество аргументов.
 */
export function sanitizePythonArgs(args?: ReadonlyArray<string>): string[] {
  if (!args || args.length === 0) {
    return [];
  }

  if (args.length > MAX_ARGS_COUNT) {
    throw new SecurityError(
      'Too many arguments for Python skill execution',
      {
        metadata: {
          maxArgs: MAX_ARGS_COUNT,
          actualArgs: args.length,
        },
      },
    );
  }

  const sanitized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.length > MAX_ARG_LENGTH) {
      throw new SecurityError(
        'Argument length exceeds configured limit',
        {
          metadata: {
            index,
            length: arg.length,
            maxLength: MAX_ARG_LENGTH,
          },
        },
      );
    }

    for (const forbidden of FORBIDDEN_ARG_CHARS) {
      if (arg.includes(forbidden)) {
        throw new SecurityError(
          'Forbidden character detected in argument',
          {
            metadata: {
              index,
              forbiddenCharacter: forbidden,
            },
          },
        );
      }
    }

    sanitized.push(arg);
  }

  return sanitized;
}

/**
 * Санитизация окружения для дочернего Python-процесса.
 *
 * - Стартует с безопасного базового окружения (PATH и служебные переменные).
 * - Пропускает только переменные из whitelist.
 * - Игнорирует попытки переопределить критичные переменные (например, PATH).
 */
export function sanitizePythonEnv(userEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const rawEnv = getRawEnv();
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: rawEnv.PATH,
    PYTHONUNBUFFERED: '1',
  };

  if (!userEnv) {
    return safeEnv;
  }

  for (const key of Object.keys(userEnv)) {
    if (ALLOWED_ENV_KEYS.indexOf(key) === -1) {
      continue;
    }

    const value = userEnv[key];

    if (value.length > MAX_ENV_VALUE_LENGTH) {
      throw new SecurityError(
        'Environment variable value exceeds configured limit',
        {
          metadata: {
            key,
            length: value.length,
            maxLength: MAX_ENV_VALUE_LENGTH,
          },
        },
      );
    }

    safeEnv[key] = value;
  }

  return safeEnv;
}

export class PythonSkillBridge {
  private readonly skillsRoot: string;
  private readonly pythonBinary: string;
  private readonly pythonArgsPrefix: ReadonlyArray<string>;
  private readonly logger: ILogger;
  private readonly securityMetrics?: PythonSkillSecurityMetrics;
  private readonly maxConcurrentProcesses: number;
  private activeProcesses: number;
  private readonly pendingQueue: Array<() => void>;

  constructor(config?: PythonSkillBridgeConfig) {
    const resolvedSkillsRoot = config?.skillsRoot ?? path.resolve(
      process.cwd(),
      'external/claude-scientific-skills/scientific-skills',
    );

    this.skillsRoot = resolvedSkillsRoot;
    this.pythonBinary = config?.pythonBinary ?? 'uv';
    this.pythonArgsPrefix = config?.pythonArgsPrefix ?? ['run', 'python'];
    this.logger = config?.logger ?? {
      log: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      info: () => {},
    };
    this.securityMetrics = config?.securityMetrics;

    const configuredMaxConcurrent = config?.maxConcurrentProcesses;
    if (
      configuredMaxConcurrent !== undefined
      && Number.isFinite(configuredMaxConcurrent)
      && configuredMaxConcurrent > 0
    ) {
      this.maxConcurrentProcesses = configuredMaxConcurrent;
    } else {
      this.maxConcurrentProcesses = 2;
    }

    this.activeProcesses = 0;
    this.pendingQueue = [];
  }

  async execute<TData = unknown>(
    options: PythonSkillOptions,
  ): Promise<PythonSkillResult<TData>>;

  async execute(
    options: PythonSkillOptions,
  ): Promise<PythonSkillResult<unknown>> {
    const { skillDir, scriptFull, scriptName } = this.validateAndResolveScriptPath(
      options.skillName,
      options.scriptPath,
    );

    const sanitizedArgs = this.sanitizeArgsWithObservability(
      options.skillName,
      scriptName,
      options.args,
    );
    const sanitizedEnv = this.sanitizeEnvWithObservability(
      options.skillName,
      scriptName,
      options.env,
    );
    const timeoutMs = this.resolveTimeout(options.timeout);

    let slotAcquired = false;

    try {
      await this.acquireConcurrencySlot();
      slotAcquired = true;

      const scriptPathArg = path.isAbsolute(scriptFull)
        ? scriptFull
        : path.resolve(scriptFull);

      const args: string[] = [
        ...this.pythonArgsPrefix,
        scriptPathArg,
        ...sanitizedArgs,
      ];

      const { stdout, stderr } = await execFileAsync(
        this.pythonBinary,
        args,
        {
          cwd: skillDir,
          env: sanitizedEnv,
          timeout: timeoutMs,
          maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
        },
      );

      const data = this.tryParseJson(stdout);

      return {
        success: true,
        output: stdout,
        error: stderr.length > 0 ? stderr : undefined,
        data,
      };
    } catch (error) {
      throw this.toPythonExecutionError(error, options.scriptPath);
    } finally {
      if (slotAcquired) {
        this.releaseConcurrencySlot();
      }
    }
  }

  private validateAndResolveScriptPath(
    skillName: string,
    scriptPath: string,
  ): {
    skillDir: string;
    scriptFull: string;
    scriptName: string;
  } {
    const trimmedSkillName = skillName.trim();
    const trimmedScriptPath = scriptPath.trim();

    if (trimmedSkillName.length === 0) {
      this.recordSecurityViolation(
        'skill_name_empty',
        {
          skillName: trimmedSkillName,
          scriptName: '',
        },
      );

      throw new SecurityError(
        'Skill name must be a non-empty string',
        {
          metadata: { skillName: trimmedSkillName },
        },
      );
    }

    // Validate skillName for path traversal attempts
    if (trimmedSkillName.includes('..') || trimmedSkillName.includes('/') || trimmedSkillName.includes('\\')) {
      this.recordSecurityViolation(
        'skill_name_path_traversal',
        {
          skillName: trimmedSkillName,
          scriptName: '',
        },
      );

      throw new SecurityError(
        'Path traversal attempt detected in skillName',
        {
          metadata: { skillName: trimmedSkillName },
        },
      );
    }

    if (trimmedScriptPath.length === 0) {
      this.recordSecurityViolation(
        'script_path_empty',
        {
          skillName: trimmedSkillName,
          scriptName: '',
          scriptPath: trimmedScriptPath,
        },
      );

      throw new SecurityError(
        'Python script path must be a non-empty string',
        {
          metadata: { skillName: trimmedSkillName },
        },
      );
    }

    const scriptName = path.basename(trimmedScriptPath);

    if (scriptName !== trimmedScriptPath) {
      this.recordSecurityViolation(
        'path_traversal',
        {
          skillName: trimmedSkillName,
          scriptName,
          scriptPath: trimmedScriptPath,
        },
      );

      throw new SecurityError(
        'Path traversal attempt detected in scriptPath',
        {
          metadata: {
            skillName: trimmedSkillName,
            scriptPath: trimmedScriptPath,
          },
        },
      );
    }

    if (!ALLOWED_SCRIPTS.has(scriptName)) {
      this.recordSecurityViolation(
        'script_not_whitelisted',
        {
          skillName: trimmedSkillName,
          scriptName,
          scriptPath: scriptName,
        },
      );

      throw new SecurityError(
        'Python script is not allowed by whitelist',
        {
          metadata: {
            skillName: trimmedSkillName,
            scriptPath: scriptName,
          },
        },
      );
    }

    const skillDir = path.join(this.skillsRoot, trimmedSkillName);
    const scriptFull = path.join(skillDir, scriptName);

    // Final path traversal validation: ensure resolved path stays within skillsRoot
    const resolvedScriptFull = path.resolve(scriptFull);
    const resolvedSkillsRoot = path.resolve(this.skillsRoot);

    if (!resolvedScriptFull.startsWith(resolvedSkillsRoot + path.sep) &&
        resolvedScriptFull !== resolvedSkillsRoot) {
      this.recordSecurityViolation(
        'path_traversal',
        {
          skillName: trimmedSkillName,
          scriptName,
          scriptPath: resolvedScriptFull,
        },
      );

      throw new SecurityError(
        'Resolved path escapes allowed directory',
        {
          metadata: {
            skillName: trimmedSkillName,
            scriptPath: resolvedScriptFull,
            allowedRoot: resolvedSkillsRoot,
          },
        },
      );
    }

    return { skillDir, scriptFull: resolvedScriptFull, scriptName };
  }

  private async acquireConcurrencySlot(): Promise<void> {
    if (this.maxConcurrentProcesses <= 0) {
      return;
    }

    if (this.activeProcesses < this.maxConcurrentProcesses) {
      this.activeProcesses += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.pendingQueue.push(resolve);
    });
    this.activeProcesses += 1;
  }

  private releaseConcurrencySlot(): void {
    if (this.maxConcurrentProcesses <= 0) {
      return;
    }

    if (this.activeProcesses > 0) {
      this.activeProcesses -= 1;
    }

    const next = this.pendingQueue.shift();
    if (next !== undefined) {
      next();
    }
  }

  private resolveTimeout(timeoutOverride?: number): number {
    if (timeoutOverride === undefined) {
      return DEFAULT_TIMEOUT_MS;
    }

    if (!Number.isFinite(timeoutOverride) || timeoutOverride <= 0) {
      return DEFAULT_TIMEOUT_MS;
    }

    if (timeoutOverride > MAX_TIMEOUT_MS) {
      return MAX_TIMEOUT_MS;
    }

    return timeoutOverride;
  }

  private tryParseJson(stdout: string): unknown {
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return undefined;
    }

    const parsed = safeJsonParse<unknown>(jsonMatch[0]);
    if (parsed === null) {
      return undefined;
    }

    return parsed;
  }

  private sanitizeArgsWithObservability(
    skillName: string,
    scriptName: string,
    args?: ReadonlyArray<string>,
  ): string[] {
    try {
      return sanitizePythonArgs(args);
    } catch (error) {
      if (error instanceof SecurityError) {
        const metadata = error.metadata;

        let argumentIndex: number | undefined;
        let forbiddenCharacter: string | undefined;
        let valueLength: number | undefined;
        let maxLength: number | undefined;
        let actualArgs: number | undefined;
        let maxArgs: number | undefined;

        if (metadata !== undefined) {
          const indexCandidate = metadata['index'];
          if (typeof indexCandidate === 'number') {
            argumentIndex = indexCandidate;
          }

          const forbiddenCandidate = metadata['forbiddenCharacter'];
          if (typeof forbiddenCandidate === 'string') {
            forbiddenCharacter = forbiddenCandidate;
          }

          const lengthCandidate = metadata['length'];
          if (typeof lengthCandidate === 'number') {
            valueLength = lengthCandidate;
          }

          const maxLengthCandidate = metadata['maxLength'];
          if (typeof maxLengthCandidate === 'number') {
            maxLength = maxLengthCandidate;
          }

          const actualArgsCandidate = metadata['actualArgs'];
          if (typeof actualArgsCandidate === 'number') {
            actualArgs = actualArgsCandidate;
          }

          const maxArgsCandidate = metadata['maxArgs'];
          if (typeof maxArgsCandidate === 'number') {
            maxArgs = maxArgsCandidate;
          }
        }

        let reason: PythonSkillSecurityViolationReason = 'forbidden_character';

        if (actualArgs !== undefined && maxArgs !== undefined) {
          reason = 'too_many_args';
        } else if (valueLength !== undefined && maxLength !== undefined) {
          reason = 'arg_too_long';
        }

        this.recordSecurityViolation(
          reason,
          {
            skillName,
            scriptName,
            argumentIndex,
            forbiddenCharacter,
            valueLength,
            maxLength,
            argumentsCount: actualArgs,
            maxArgumentsCount: maxArgs,
          },
        );
      }

      throw error;
    }
  }

  private sanitizeEnvWithObservability(
    skillName: string,
    scriptName: string,
    env?: Record<string, string>,
  ): NodeJS.ProcessEnv {
    try {
      return sanitizePythonEnv(env);
    } catch (error) {
      if (error instanceof SecurityError) {
        const metadata = error.metadata;

        let envKey: string | undefined;
        let valueLength: number | undefined;
        let maxLength: number | undefined;

        if (metadata !== undefined) {
          const keyCandidate = metadata['key'];
          if (typeof keyCandidate === 'string') {
            envKey = keyCandidate;
          }

          const lengthCandidate = metadata['length'];
          if (typeof lengthCandidate === 'number') {
            valueLength = lengthCandidate;
          }

          const maxLengthCandidate = metadata['maxLength'];
          if (typeof maxLengthCandidate === 'number') {
            maxLength = maxLengthCandidate;
          }
        }

        this.recordSecurityViolation(
          'env_value_too_long',
          {
            skillName,
            scriptName,
            envKey,
            valueLength,
            maxLength,
          },
        );
      }

      throw error;
    }
  }

  private recordSecurityViolation(
    reason: PythonSkillSecurityViolationReason,
    details: {
      skillName: string;
      scriptName: string;
      scriptPath?: string;
      argumentIndex?: number;
      forbiddenCharacter?: string;
      envKey?: string;
      valueLength?: number;
      maxLength?: number;
      argumentsCount?: number;
      maxArgumentsCount?: number;
    },
  ): void {
    const meta: Record<string, unknown> = {
      reason,
      skillName: details.skillName,
      scriptName: details.scriptName,
    };

    if (details.scriptPath !== undefined) {
      meta.scriptPath = details.scriptPath;
    }
    if (details.argumentIndex !== undefined) {
      meta.argumentIndex = details.argumentIndex;
    }
    if (details.forbiddenCharacter !== undefined) {
      meta.forbiddenCharacter = details.forbiddenCharacter;
    }
    if (details.envKey !== undefined) {
      meta.envKey = details.envKey;
    }
    if (details.valueLength !== undefined) {
      meta.valueLength = details.valueLength;
    }
    if (details.maxLength !== undefined) {
      meta.maxLength = details.maxLength;
    }
    if (details.argumentsCount !== undefined) {
      meta.argumentsCount = details.argumentsCount;
    }
    if (details.maxArgumentsCount !== undefined) {
      meta.maxArgumentsCount = details.maxArgumentsCount;
    }

    this.logger.warn('Security violation detected in PythonSkillBridge', meta);

    if (this.securityMetrics !== undefined) {
      this.securityMetrics.increment({
        reason,
        skillName: details.skillName,
        scriptName: details.scriptName,
      });
    }
  }

  private toPythonExecutionError(error: unknown, scriptPath: string): PythonExecutionError {
    if (error instanceof Error) {
      return new PythonExecutionError(
        `Python script execution failed: ${scriptPath}`,
        {
          metadata: {
            scriptPath,
            underlyingErrorMessage: error.message,
          },
          cause: error,
        },
      );
    }

    return new PythonExecutionError(
      `Python script execution failed: ${scriptPath}`,
      {
        metadata: {
          scriptPath,
          underlyingErrorType: typeof error,
        },
      },
    );
  }
}
