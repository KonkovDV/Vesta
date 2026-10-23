import { PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';

export const manifest: PluginManifest = {
  name: 'code-interpreter',
  version: '1.0.0',
  description: 'Provides safe JavaScript execution environment (Standard Library)',
  author: 'MicroPhoenix Team',
  tags: ['tool', 'code', 'vm'],
};
