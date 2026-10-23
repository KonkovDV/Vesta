/**
 * In-memory Integration Hub for enterprise adapters.
 * Layer: Integration.
 *
 * Name-based adapter registry with broadcast capability.
 */

export interface IntegrationPayload {
  text: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface IIntegrationAdapter {
  name: string;
  send(payload: IntegrationPayload): Promise<void>;
}

export class IntegrationHub {
  private readonly adaptersByName = new Map<string, IIntegrationAdapter>();

  registerAdapter(adapter: IIntegrationAdapter): void {
    this.adaptersByName.set(adapter.name, adapter);
  }

  getAdapter(name: string): IIntegrationAdapter | undefined {
    return this.adaptersByName.get(name);
  }

  listAdapters(): string[] {
    return Array.from(this.adaptersByName.keys());
  }

  async broadcast(payload: IntegrationPayload): Promise<{ sent: string[]; failed: string[] }> {
    const sent: string[] = [];
    const failed: string[] = [];

    for (const [name, adapter] of this.adaptersByName) {
      try {
        await adapter.send(payload);
        sent.push(name);
      } catch {
        failed.push(name);
      }
    }

    return { sent, failed };
  }
}