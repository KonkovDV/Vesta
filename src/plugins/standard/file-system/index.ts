import * as fs from 'fs/promises';
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
          const safePath = this.validatePath(typedArgs.path);
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
          const safePath = this.validatePath(typedArgs.path);
          // Ensure directory exists
          await fs.mkdir(path.dirname(safePath), { recursive: true });
          await fs.writeFile(safePath, typedArgs.content, 'utf-8');
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
          const safePath = this.validatePath(targetPath);
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
   * Validates that the requested path is within the sandbox root.
   * Prevents Directory Traversal attacks.
   */
  private validatePath(userPath: string): string {
    // Normalize path to resolve '..' and '.'
    const safePath = path.normalize(path.join(this.sandboxRoot, userPath));

    // Check if the resolved path starts with the sandbox root
    if (!safePath.startsWith(this.sandboxRoot)) {
      throw new Error(`Access Denied: Path '${userPath}' attempts to access outside sandbox.`);
    }

    return safePath;
  }
}
