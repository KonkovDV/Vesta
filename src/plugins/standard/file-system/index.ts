import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import type { Dirent } from 'fs';
import * as path from 'path';
import { IMicroPhoenixPlugin, IPluginContext, PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';
import { manifest } from './manifest';
import { z } from 'zod';

export default class FileSystemPlugin implements IMicroPhoenixPlugin {
  readonly manifest: PluginManifest = manifest;
  private sandboxRoot!: string;

  async onLoad(context: IPluginContext): Promise<void> {
    // 1. Initialize Sandbox Root
    this.sandboxRoot = path.resolve(process.cwd(), 'sandbox', 'fs');
    await fs.mkdir(this.sandboxRoot, { recursive: true });
    
    context.logger.info?.(`FileSystemPlugin: Sandbox root initialized at ${this.sandboxRoot}`);

    // 2. Register fs_read_file
    context.tools.register({
      name: 'fs_read_file',
      description: 'Read a text file from the sandbox',
      schema: z.object({
        path: z.string().describe('Relative path to file (e.g., "notes.txt")')
      }),
      matches: (name) => name === 'fs_read_file',
      execute: async (args) => {
        try {
          const typedArgs = args as { path: string };
          const safePath = await this.resolveInside(typedArgs.path);
          const content = await fs.readFile(safePath, 'utf-8');
          return content;
        } catch (error) {
          return `Error reading file: ${(error as Error).message}`;
        }
      }
    });

    // 3. Register fs_write_file
    context.tools.register({
      name: 'fs_write_file',
      description: 'Write text to a file in the sandbox (overwrites if exists)',
      schema: z.object({
        path: z.string().describe('Relative path (e.g., "notes.txt")'),
        content: z.string().describe('Text content to write')
      }),
      matches: (name) => name === 'fs_write_file',
      execute: async (args) => {
        try {
          const typedArgs = args as { path: string; content: string };
          const safePath = await this.resolveInside(typedArgs.path);
          // Ensure directory exists
          await fs.mkdir(path.dirname(safePath), { recursive: true });
          // Re-check after mkdir: a directory created by someone else may be a link.
          await this.resolveInside(typedArgs.path);
          // 'wx' would refuse overwrite; O_NOFOLLOW refuses a symlink at the final component.
          const handle = await fs.open(safePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o600);
          try {
            await handle.writeFile(typedArgs.content, 'utf-8');
          } finally {
            await handle.close();
          }
          return `Success: File written to ${typedArgs.path}`;
        } catch (error) {
          return `Error writing file: ${(error as Error).message}`;
        }
      }
    });

    // 4. Register fs_list_dir
    context.tools.register({
      name: 'fs_list_dir',
      description: 'List files and directories in a path',
      schema: z.object({
        path: z.string().optional().describe('Relative path (default: root)')
      }),
      matches: (name) => name === 'fs_list_dir',
      execute: async (args) => {
        try {
          const typedArgs = args as { path?: string };
          const targetPath = typedArgs.path || '.';
          const safePath = await this.resolveInside(targetPath);
          const entries = await fs.readdir(safePath, { withFileTypes: true });
          
          return JSON.stringify(entries.map((e: Dirent) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file'
          })), null, 2);
        } catch (error) {
          return `Error listing directory: ${(error as Error).message}`;
        }
      }
    });
  }

  async onUnload(): Promise<void> {
    // Optional: Cleanup temp files if needed, but for now we persist.
  }

  /**
   * The requested path, resolved through every symlink of its existing part, must
   * stay inside the real sandbox root. A prefix test on the joined string accepted
   * a sibling such as sandbox/fs-other and any link that pointed out.
   */
  async resolveInside(userPath: string): Promise<string> {
    const root = await fs.realpath(this.sandboxRoot);
    const requested = path.resolve(root, userPath);
    if (!isWithin(root, requested)) {
      throw new Error(`Access Denied: Path '${userPath}' attempts to access outside sandbox.`);
    }
    // Walk up to the deepest part that exists and resolve it for real.
    let existing = requested;
    let suffix = '';
    for (;;) {
      try {
        const real = await fs.realpath(existing);
        const resolved = suffix ? path.join(real, suffix) : real;
        if (!isWithin(root, resolved)) {
          throw new Error(`Access Denied: Path '${userPath}' resolves outside sandbox.`);
        }
        return resolved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        suffix = suffix ? path.join(path.basename(existing), suffix) : path.basename(existing);
        existing = parent;
      }
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
