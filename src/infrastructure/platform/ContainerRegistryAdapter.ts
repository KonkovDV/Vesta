import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';
import { isNewerVersion, parseMajorVersion } from '../../core/utils/version';
import type {
  AvailableUpdate,
  IContainerRegistryClient,
  ParsedImageReference,
} from '../../domain/platform/IContainerRegistryClient';
import type { IHttpClient, HttpClientResponse } from '../http/HttpClient';
import { pinnedExchange } from '../http/SsrfPinnedHttpClient';
import type { PinnedEndpoint } from '../security/SsrfDnsGuard';

interface IUrlValidator {
  validateUrl(url: string): Promise<void>;
  pinUrl?(url: string): Promise<PinnedEndpoint>;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

interface ContainerRegistryAdapterDeps {
  httpClient: IHttpClient;
  ssrfGuard: IUrlValidator;
  logger?: Pick<IStructuredLogger, 'warn' | 'debug'>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  timeoutMs?: number;
}

const SEMVER_TAG_PATTERN = /^v?(\d+\.\d+(?:\.\d+)?)$/;
const PLATFORM_SUFFIXES = ['-arm64', '-amd64', '-alpine', '-slim', '-cuda', '-rocm'];
const REJECTED_TAGS = new Set(['latest', 'nightly', 'edge', 'dev', 'beta', 'alpha', 'canary', 'rc', 'test', 'debug']);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

type RegistryJsonResponse<T> = {
  response: HttpClientResponse;
  data: T;
};

export class ContainerRegistryAdapter implements IContainerRegistryClient {
  private readonly tokenCache = new Map<string, TokenCacheEntry>();
  private readonly sourceUrlCache = new Map<string, string | null>();
  private readonly releaseTagPrefixCache = new Map<string, string>();
  private readonly logger?: Pick<IStructuredLogger, 'warn' | 'debug'>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ContainerRegistryAdapterDeps) {
    this.logger = deps.logger;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  parseImageReference(image: string): ParsedImageReference {
    let registry: string;
    let remainder: string;
    let tag = 'latest';
    let normalizedImage = image;

    const lastColon = normalizedImage.lastIndexOf(':');
    if (lastColon > -1 && !normalizedImage.substring(lastColon).includes('/')) {
      tag = normalizedImage.substring(lastColon + 1);
      normalizedImage = normalizedImage.substring(0, lastColon);
    }

    const parts = normalizedImage.split('/');
    if (parts.length === 1) {
      registry = 'registry-1.docker.io';
      remainder = `library/${parts[0]}`;
    } else if (parts.length === 2 && !parts[0].includes('.') && !parts[0].includes(':')) {
      registry = 'registry-1.docker.io';
      remainder = normalizedImage;
    } else {
      registry = parts[0];
      remainder = parts.slice(1).join('/');
    }

    const namespaceParts = remainder.split('/');
    const repo = namespaceParts.pop() ?? '';
    const namespace = namespaceParts.join('/');

    return {
      registry,
      namespace,
      repo,
      tag,
      fullName: remainder,
    };
  }

  async listTags(parsed: ParsedImageReference): Promise<string[]> {
    const token = await this.getToken(parsed.registry, parsed.fullName);
    const tags = new Set<string>();
    let url = `https://${parsed.registry}/v2/${parsed.fullName}/tags/list?n=1000`;

    while (url) {
      const { response, data } = await this.requestJson<{ tags?: string[] }>(url, {
        Authorization: `Bearer ${token}`,
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Failed to list tags for ${parsed.fullName}: ${response.statusCode}`);
      }

      for (const tag of data.tags ?? []) {
        tags.add(tag);
      }

      url = this.resolveNextLink(url, getHeader(response.headers, 'link'));
    }

    return Array.from(tags);
  }

  async checkArchSupport(parsed: ParsedImageReference, tag: string, hostArch: string): Promise<boolean> {
    try {
      const token = await this.getToken(parsed.registry, parsed.fullName);
      const url = `https://${parsed.registry}/v2/${parsed.fullName}/manifests/${tag}`;
      const { response, data } = await this.requestJson<{
        mediaType?: string;
        manifests?: Array<{ platform?: { architecture?: string } }>;
      }>(url, {
        Authorization: `Bearer ${token}`,
        Accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
        ].join(', '),
      });

      if (response.statusCode < 200 || response.statusCode >= 300) {
        this.logger?.warn?.('[ContainerRegistryAdapter] Manifest lookup failed during architecture probe', {
          tag,
          image: parsed.fullName,
          statusCode: response.statusCode,
        });
        return false;
      }

      const mediaType = data.mediaType || getHeader(response.headers, 'content-type') || '';
      if (mediaType.includes('manifest.list') || mediaType.includes('image.index') || data.manifests) {
        return (data.manifests ?? []).some((manifest) => manifest.platform?.architecture === hostArch);
      }

      return true;
    } catch (error) {
      this.logger?.warn?.('[ContainerRegistryAdapter] Failed to inspect architecture support', {
        tag,
        image: parsed.fullName,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async getSourceUrl(parsed: ParsedImageReference): Promise<string | null> {
    const cacheKey = `${parsed.registry}/${parsed.fullName}`;
    if (this.sourceUrlCache.has(cacheKey)) {
      return this.sourceUrlCache.get(cacheKey) ?? null;
    }

    try {
      const token = await this.getToken(parsed.registry, parsed.fullName);
      const manifestUrl = `https://${parsed.registry}/v2/${parsed.fullName}/manifests/${parsed.tag}`;
      const manifestResult = await this.requestJson<{
        config?: { digest?: string };
        manifests?: Array<{ digest?: string }>;
      }>(manifestUrl, {
        Authorization: `Bearer ${token}`,
        Accept: [
          'application/vnd.oci.image.manifest.v1+json',
          'application/vnd.docker.distribution.manifest.v2+json',
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ].join(', '),
      });

      if (manifestResult.response.statusCode < 200 || manifestResult.response.statusCode >= 300) {
        this.sourceUrlCache.set(cacheKey, null);
        return null;
      }

      let configDigest = manifestResult.data.config?.digest;
      if (!configDigest && manifestResult.data.manifests?.length) {
        const firstDigest = manifestResult.data.manifests[0]?.digest;
        if (firstDigest) {
          const childManifest = await this.requestJson<{ config?: { digest?: string } }>(
            `https://${parsed.registry}/v2/${parsed.fullName}/manifests/${firstDigest}`,
            {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json',
            },
          );
          if (childManifest.response.statusCode >= 200 && childManifest.response.statusCode < 300) {
            configDigest = childManifest.data.config?.digest;
          }
        }
      }

      if (!configDigest) {
        this.sourceUrlCache.set(cacheKey, null);
        return null;
      }

      const blobResult = await this.requestJson<{
        config?: { Labels?: Record<string, string> };
      }>(`https://${parsed.registry}/v2/${parsed.fullName}/blobs/${configDigest}`, {
        Authorization: `Bearer ${token}`,
      });

      if (blobResult.response.statusCode < 200 || blobResult.response.statusCode >= 300) {
        this.sourceUrlCache.set(cacheKey, null);
        return null;
      }

      const sourceUrl = blobResult.data.config?.Labels?.['org.opencontainers.image.source'] ?? null;
      this.sourceUrlCache.set(cacheKey, sourceUrl);
      return sourceUrl;
    } catch (error) {
      this.logger?.warn?.('[ContainerRegistryAdapter] Failed to resolve source URL', {
        image: parsed.fullName,
        error: error instanceof Error ? error.message : String(error),
      });
      this.sourceUrlCache.set(cacheKey, null);
      return null;
    }
  }

  async detectReleaseTagPrefix(sourceUrl: string, sampleTag: string): Promise<string> {
    if (this.releaseTagPrefixCache.has(sourceUrl)) {
      return this.releaseTagPrefixCache.get(sourceUrl) ?? '';
    }

    try {
      const url = new URL(sourceUrl);
      if (url.hostname !== 'github.com') {
        this.releaseTagPrefixCache.set(sourceUrl, '');
        return '';
      }

      const cleanPath = url.pathname.replace(/\.git$/, '').replace(/\/$/, '');
      const strippedTag = sampleTag.replace(/^v/, '');
      const vTag = `v${strippedTag}`;

      const prefixed = await this.request(
        `https://api.github.com/repos${cleanPath}/releases/tags/${vTag}`,
        {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MicroPhoenix',
        },
        1,
      );
      if (prefixed.statusCode >= 200 && prefixed.statusCode < 300) {
        this.releaseTagPrefixCache.set(sourceUrl, 'v');
        return 'v';
      }

      const plain = await this.request(
        `https://api.github.com/repos${cleanPath}/releases/tags/${strippedTag}`,
        {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MicroPhoenix',
        },
        1,
      );
      if (plain.statusCode >= 200 && plain.statusCode < 300) {
        this.releaseTagPrefixCache.set(sourceUrl, '');
        return '';
      }
    } catch {
      // Fall through to default.
    }

    this.releaseTagPrefixCache.set(sourceUrl, '');
    return '';
  }

  buildReleaseUrl(sourceUrl: string, tag: string, releaseTagPrefix: string): string | undefined {
    try {
      const url = new URL(sourceUrl);
      const cleanPath = url.pathname.replace(/\.git$/, '').replace(/\/$/, '');
      const strippedTag = tag.replace(/^v/, '');
      const releaseTag = releaseTagPrefix
        ? `${releaseTagPrefix}${strippedTag}`
        : url.hostname.includes('gitlab') && tag.startsWith('v')
          ? tag
          : strippedTag;

      if (url.hostname === 'github.com') {
        return `${url.origin}${cleanPath}/releases/tag/${releaseTag}`;
      }

      if (url.hostname.includes('gitlab')) {
        return `${url.origin}${cleanPath}/-/releases/${releaseTag}`;
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  filterCompatibleUpdates(tags: string[], currentTag: string, majorVersion: number): string[] {
    return tags
      .filter((tag) => {
        if (!SEMVER_TAG_PATTERN.test(tag)) {
          return false;
        }

        if (REJECTED_TAGS.has(tag.toLowerCase())) {
          return false;
        }

        if (PLATFORM_SUFFIXES.some((suffix) => tag.toLowerCase().endsWith(suffix))) {
          return false;
        }

        if (parseMajorVersion(tag) !== majorVersion) {
          return false;
        }

        return isNewerVersion(tag, currentTag);
      })
      .sort((left, right) => (isNewerVersion(left, right) ? -1 : 1));
  }

  async getAvailableUpdates(
    containerImage: string,
    hostArch: string,
    fallbackSourceRepo?: string | null,
  ): Promise<AvailableUpdate[]> {
    const parsed = this.parseImageReference(containerImage);
    const currentTag = parsed.tag;

    if (currentTag === 'latest') {
      this.logger?.warn?.('[ContainerRegistryAdapter] Cannot check updates for latest-tagged image', {
        image: containerImage,
      });
      return [];
    }

    const majorVersion = parseMajorVersion(currentTag);
    const sourceUrlPromise = this.getSourceUrl(parsed)
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    let tags: string[];
    try {
      tags = await this.listTags(parsed);
    } catch (error) {
      this.logger?.warn?.('[ContainerRegistryAdapter] Failed to list registry tags', {
        image: containerImage,
        error: String(error),
      });
      return [];
    }

    const sourceUrlResult = await sourceUrlPromise;
    if (!sourceUrlResult.ok) {
      this.logger?.debug?.('[ContainerRegistryAdapter] Failed to resolve OCI source URL', {
        image: containerImage,
        error: String(sourceUrlResult.error),
      });
    }

    const ociSourceUrl = sourceUrlResult.ok ? sourceUrlResult.value : null;
    const sourceUrl = ociSourceUrl || fallbackSourceRepo || null;
    const compatibleTags = this.filterCompatibleUpdates(tags, currentTag, majorVersion);

    let releaseTagPrefix = '';
    if (sourceUrl) {
      releaseTagPrefix = await this.detectReleaseTagPrefix(sourceUrl, currentTag);
    }

    const updates: AvailableUpdate[] = [];
    for (const tag of compatibleTags) {
      if (await this.checkArchSupport(parsed, tag, hostArch)) {
        updates.push({
          tag,
          isLatest: updates.length === 0,
          releaseUrl: sourceUrl ? this.buildReleaseUrl(sourceUrl, tag, releaseTagPrefix) : undefined,
        });
      }
    }

    return updates;
  }

  private async getToken(registry: string, fullName: string): Promise<string> {
    const cacheKey = `${registry}/${fullName}`;
    const cached = this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return cached.token;
    }

    const tokenUrl = this.buildTokenUrl(registry, fullName);
    const { response, data } = await this.requestJson<{ token?: string; access_token?: string }>(tokenUrl);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Failed to get auth token from ${registry}: ${response.statusCode}`);
    }

    const token = data.token || data.access_token || '';
    if (!token) {
      throw new Error(`No token returned from ${registry}`);
    }

    this.tokenCache.set(cacheKey, {
      token,
      expiresAt: this.now() + DEFAULT_TOKEN_TTL_MS,
    });
    return token;
  }

  private buildTokenUrl(registry: string, fullName: string): string {
    if (registry === 'registry-1.docker.io') {
      return `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${fullName}:pull`;
    }

    if (registry === 'ghcr.io') {
      return `https://ghcr.io/token?service=ghcr.io&scope=repository:${fullName}:pull`;
    }

    return `https://${registry}/token?service=${registry}&scope=repository:${fullName}:pull`;
  }

  private async requestJson<T>(
    url: string,
    headers?: Record<string, string>,
    maxRetries?: number,
  ): Promise<RegistryJsonResponse<T>> {
    const response = await this.request(url, headers, maxRetries);
    const body = response.body.trim();
    const data = body.length > 0 ? (JSON.parse(body) as T) : ({} as T);
    return { response, data };
  }

  private async request(
    url: string,
    headers?: Record<string, string>,
    maxRetries = 3,
  ): Promise<HttpClientResponse> {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.load(url, headers);

      if (response.statusCode === 429 && attempt < maxRetries) {
        const delayMs = this.computeRetryDelay(response, attempt);
        this.logger?.warn?.('[ContainerRegistryAdapter] Rate limited by upstream registry', {
          url,
          attempt,
          delayMs,
        });
        await this.sleep(delayMs);
        continue;
      }

      return response;
    }

    throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
  }

  private async load(url: string, headers?: Record<string, string>): Promise<HttpClientResponse> {
    const pinUrl = this.deps.ssrfGuard.pinUrl?.bind(this.deps.ssrfGuard);
    if (pinUrl) {
      const pinned = await pinnedExchange({ pinUrl }, {
        method: 'GET',
        url,
        timeoutMs: this.timeoutMs,
        headers: headers ?? {},
      });
      return { statusCode: pinned.statusCode, headers: pinned.headers, body: pinned.body };
    }
    await this.deps.ssrfGuard.validateUrl(url);
    return this.deps.httpClient.request({
      method: 'GET',
      url,
      timeoutMs: this.timeoutMs,
      headers,
    });
  }

  private computeRetryDelay(response: HttpClientResponse, attempt: number): number {
    const retryAfter = getHeader(response.headers, 'retry-after');
    if (retryAfter) {
      const retryAfterSeconds = parseInt(retryAfter, 10);
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        return retryAfterSeconds * 1000;
      }
    }

    return (2 ** attempt) * 1000 + Math.floor(this.random() * 250);
  }

  private resolveNextLink(baseUrl: string, linkHeader?: string): string {
    if (!linkHeader) {
      return '';
    }

    const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/i);
    if (!match) {
      return '';
    }

    try {
      return new URL(match[1], baseUrl).toString();
    } catch {
      return '';
    }
  }
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const header = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}