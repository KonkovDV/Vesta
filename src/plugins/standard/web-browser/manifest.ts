import { PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';

export const manifest: PluginManifest = {
  name: 'web-browser',
  version: '1.0.0',
  description: 'Provides web browsing capabilities via Puppeteer/Playwright',
  author: 'MicroPhoenix Team',
  tags: ['tool', 'browser', 'automation'],
};
