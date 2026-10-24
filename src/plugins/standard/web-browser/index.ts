
import { IMicroPhoenixPlugin, IPluginContext, PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';
import { IAgentTool } from '../../../domain/agents/tools.interface';
import { manifest } from './manifest';
import type { ILogger } from '../../../core/decorators/ILogger';
import { z } from 'zod';
import { SsrfDnsGuard } from '../../../infrastructure/security/SsrfDnsGuard';

type Browser = import('puppeteer').Browser;
type Page = import('puppeteer').Page;

export default class WebBrowserPlugin implements IMicroPhoenixPlugin {
  readonly manifest: PluginManifest = manifest;
  private browser: Browser | null = null;
    private logger: ILogger | null = null;
  /** Checks the navigation target and every request the page makes. */
  private readonly guard = new SsrfDnsGuard();
  private readonly guardedPages = new WeakSet<Page>();

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
            // z.string().url() accepts file:, chrome: and javascript: URLs.
            await assertBrowsableUrl(this.guard, typedArgs.url);
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
          // The page content is untrusted. Chrome's own sandbox stays on unless the
          // operator turns it off for an image that cannot provide it.
          const noSandbox = process.env.PUPPETEER_NO_SANDBOX === 'true';
          this.browser = await puppeteer.launch({
              headless: true,
              args: noSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
          });
      }
      const pages = await this.browser.pages();
      const page = pages.length > 0 ? pages[0] : await this.browser.newPage();
      await this.guardPage(page);
      return page;
  }

  /**
   * Every subresource, redirect and script-initiated request is checked too. The
   * browser resolves names itself, so a rebinding DNS answer can still differ from
   * this check: run the browser behind an egress proxy for a hard boundary.
   */
  private async guardPage(page: Page): Promise<void> {
      if (this.guardedPages.has(page)) return;
      this.guardedPages.add(page);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
          const url = request.url();
          if (url.startsWith('data:') || url === 'about:blank') {
              void request.continue();
              return;
          }
          assertBrowsableUrl(this.guard, url)
              .then(() => request.continue())
              .catch(() => request.abort('blockedbyclient'));
      });
  }
}

export async function assertBrowsableUrl(guard: Pick<SsrfDnsGuard, 'validateUrl'>, url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`web-browser: scheme ${parsed.protocol} is not allowed`);
  }
  await guard.validateUrl(url);
}
