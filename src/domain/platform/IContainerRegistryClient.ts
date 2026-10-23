export interface ParsedImageReference {
  registry: string;
  namespace: string;
  repo: string;
  tag: string;
  fullName: string;
}

export interface AvailableUpdate {
  tag: string;
  isLatest: boolean;
  releaseUrl?: string;
}

export interface IContainerRegistryClient {
  parseImageReference(image: string): ParsedImageReference;
  listTags(parsed: ParsedImageReference): Promise<string[]>;
  checkArchSupport(parsed: ParsedImageReference, tag: string, hostArch: string): Promise<boolean>;
  getSourceUrl(parsed: ParsedImageReference): Promise<string | null>;
  detectReleaseTagPrefix(sourceUrl: string, sampleTag: string): Promise<string>;
  buildReleaseUrl(sourceUrl: string, tag: string, releaseTagPrefix: string): string | undefined;
  filterCompatibleUpdates(tags: string[], currentTag: string, majorVersion: number): string[];
  getAvailableUpdates(
    containerImage: string,
    hostArch: string,
    fallbackSourceRepo?: string | null,
  ): Promise<AvailableUpdate[]>;
}