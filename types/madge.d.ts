declare module 'madge' {
  export interface MadgeOptions {
    baseDir?: string;
    includeNpm?: boolean;
    fileExtensions?: string[];
    tsConfig?: string;
    detectiveOptions?: unknown;
    // allow extra options without over-constraining the API
    [key: string]: unknown;
  }

  export interface MadgeInstance {
    circular(): string[][];
  }

  export default function madge(
    entry: string,
    options?: MadgeOptions
  ): Promise<MadgeInstance>;
}