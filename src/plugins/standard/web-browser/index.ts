
import { IMicroPhoenixPlugin, IPluginContext, PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';
import { IAgentTool } from '../../../domain/agents/tools.interface';
import { manifest } from './manifest';
import type { ILogger } from '../../../core/decorators/ILogger';
import { z } from 'zod';

type Browser = import('puppeteer').Browser;
type Page = import('puppeteer').Page;

export default class WebBrowserPlugin implements IMicroPhoenixPlugin {
  readonly manifest: PluginManifest = manifest;
  private browser: Browser | null = null;
    private logger: ILogger | null = null;

  async onLoad(context: IPluginContext): Promise<void> {
    this.logger = context.logger;
    this.logger.info(`WebBrowserPlugin: Loading...`);

    // Register Tools
    this.registerNavigateTool(context);
    this.registerScreenshotTool(context);

    this.logger.info(`WebBrowserPlugin: Loaded successfully.`);
  }

  async onUnload(): Promise<void> {
    if (this.browser) {
        this.logger!.info(`WebBrowserPlugin: Closing browser...`);
        await this.browser.close();
        this.browser = null;
    }
  }

  private registerNavigateTool(context: IPluginContext) {
    const tool: IAgentTool = {
        name: 'web-browser.navigate',
        description: 'Navigate to a URL and return the page content (text).',
        matches: (name) => name === 'web-browser.navigate',
        schema: z.object({
            url: z.string().url(),
            waitForSelector: z.string().optional()
        }),
        execute: async (args, agentContext) => {
            const typedArgs = args as { url: string; waitForSelector?: string };
            const page = await this.getPage();
            this.logger!.debug(`Navigating to ${typedArgs.url}`);
            await page.goto(typedArgs.url, { waitUntil: 'networkidle0' });
            
            if (typedArgs.waitForSelector) {
                await page.waitForSelector(typedArgs.waitForSelector, { timeout: 5000 });
            }

            const content = await page.evaluate(() => document.body.innerText);
            return {
                url: page.url(),
                title: await page.title(),
                content: content.substring(0, 5000) // Truncate for safety
            };
        }
    };
    context.tools.register(tool);
  }

  private registerScreenshotTool(context: IPluginContext) {
    const tool: IAgentTool = {
        name: 'web-browser.screenshot',
        description: 'Take a screenshot of the current page.',
        matches: (name) => name === 'web-browser.screenshot',
        schema: z.object({
            fullPage: z.boolean().optional()
        }),
        execute: async (args, agentContext) => {
             const typedArgs = args as { fullPage?: boolean };
             const page = await this.getPage();
             const screenshot = await page.screenshot({ 
                 encoding: 'base64',
                 fullPage: typedArgs.fullPage || false 
             });
             return {
                 mimeType: 'image/png',
                 data: screenshot
             };
        }
    };
    context.tools.register(tool);
  }

  private async getPage(): Promise<Page> {
      if (!this.browser) {
          this.logger!.info("Launching Puppeteer...");
          const { default: puppeteer } = await import('puppeteer');
          this.browser = await puppeteer.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox'] // For container safety
          });
      }
      const pages = await this.browser.pages();
      if (pages.length > 0) return pages[0];
      return await this.browser.newPage();
  }
}
