import { IMicroPhoenixPlugin, IPluginContext, PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';
import { manifest } from './manifest';
import { z } from 'zod';

export default class CodeInterpreterPlugin implements IMicroPhoenixPlugin {
  readonly manifest: PluginManifest = manifest;

  async onLoad(context: IPluginContext): Promise<void> {
    context.logger.info?.(`CodeInterpreterPlugin: Loaded (code_execute is disabled until it runs in a process container).`);

    // Register code_execute tool
    context.tools.register({
      name: 'code_execute',
      description: 'Disabled. node:vm is not an isolation boundary; use the contained bash or python tool.',
      schema: z.object({
        code: z.string().describe('JavaScript code to execute. access to process/require is disabled.')
      }),
      matches: (name) => name === 'code_execute',
      // node:vm is not a security boundary (Node.js documentation): a host function
      // in the context, such as console.log, gives back the host `process`
      // (console.log.constructor('return process')()). The tool refuses to run code
      // until it executes inside IProcessContainer like the bash and python tools.
      execute: async () => JSON.stringify({
        error: 'code_execute is disabled: node:vm does not isolate code. Use the contained bash or python tool.',
        logs: [],
      }, null, 2),
    });
  }

  async onUnload(): Promise<void> {
    // cleanup
  }
}
