import { z } from 'zod';
import { PythonSkillBridge } from '../../adapters/scientific/PythonSkillBridge';
import type {
  IPlugin,
  IPluginManifest,
  PluginExecutionContext,
} from '../../../domain/plugins/plugin-types';
import { ValidationError } from '../../../domain/errors/DomainError';

// NOTE: identity (name + version) is exposed via manifest and used by
// PluginImplementationRegistry to derive the entrypoint ref "scientific-skills@1.0.0".

const MAX_ARGS_LENGTH = 32;
const MAX_ARG_STRING_LENGTH = 1000;
const MAX_ENV_VALUE_LENGTH = 1024;

const ScientificSkillPayloadSchema = z.object({
  skill: z.string().min(1).max(64),
  script: z
    .string()
    .min(1)
    .max(128)
    // Не допускаем path-разделители, чтобы не было path traversal до PythonSkillBridge.
    .refine((value) => !value.includes('/') && !value.includes('\\'), {
      message: 'script must not contain path separators',
    }),
  args: z
    .array(z.string().max(MAX_ARG_STRING_LENGTH))
    .max(MAX_ARGS_LENGTH)
    .optional(),
  env: z
    .record(z.string(), z.string().max(MAX_ENV_VALUE_LENGTH))
    .optional(),
});

type ScientificSkillPayload = z.infer<typeof ScientificSkillPayloadSchema>;

export class ScientificSkillPlugin implements IPlugin<unknown, unknown> {
  readonly manifest: IPluginManifest = {
    name: 'scientific-skills',
    version: '1.0.0',
  };

  constructor(private readonly bridge: PythonSkillBridge) {}

  async execute(input: unknown, _context: PluginExecutionContext): Promise<unknown> {
    const parsed = ScientificSkillPayloadSchema.safeParse(input);

    if (!parsed.success) {
      throw ValidationError.fromZodError(parsed.error);
    }

    const payload: ScientificSkillPayload = parsed.data;

    const result = await this.bridge.execute({
      skillName: payload.skill,
      scriptPath: payload.script,
      args: payload.args,
      env: payload.env,
      // 1 minute timeout для научных задач на уровне плагина,
      // дополнительный верхний предел реализован в PythonSkillBridge.
      timeout: 60_000,
    });

    if (result.data !== undefined && result.data !== null) {
      return result.data;
    }

    return result.output;
  }
}