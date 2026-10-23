declare module 'node-edge-tts' {
  import { Readable } from 'node:stream';

  export class MsEdgeTTS {
    setMetadata(voice: string, outputFormat: string): Promise<void>;
    toStream(text: string): Readable;
  }
}
