import { Bonjour, Browser, Service } from 'bonjour-service';
import { v4 as uuidv4 } from 'uuid';
import {
  IServiceDiscovery,
  ServiceRegistration,
  ServiceInstance,
  ServiceWatchCallback,
  ServiceDiscoveryError,
  HealthStatus,
} from '../../domain/service-discovery';

/**
 * mDNS Service Discovery implementation using Bonjour.
 * @layer Infrastructure
 */
export class BonjourDiscoveryService implements IServiceDiscovery {
  private readonly bonjour: Bonjour;
  private readonly publishedServices = new Map<string, Service>();
  private readonly browsers = new Map<string, Browser>();
  private readonly nodeId: string;
  private readonly serviceType = 'singularity'; // maps to _singularity._tcp

  constructor(config: { nodeId?: string } = {}) {
    this.bonjour = new Bonjour();
    this.nodeId = config.nodeId || uuidv4();
  }

    private toErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

  async register(service: ServiceRegistration): Promise<void> {
    try {
        // Map metadata to TXT record format (Key-Value strings)
        const txt: Record<string, string> = {
            id: service.id,
            type: service.type,
            ...service.metadata,
        };

        const name = `${service.type}-${this.nodeId.substring(0, 8)}`;

        const bonjourService = this.bonjour.publish({
            name: name,
            type: this.serviceType, // We use one main type and filter by subtype/TXT
            port: service.port,
            host: service.host,
            txt: txt,
        });

        this.publishedServices.set(service.id, bonjourService);
        console.log(`[Bonjour] Published service: ${name} (${service.type}) on port ${service.port}`);
    } catch (error: unknown) {
        throw new ServiceDiscoveryError(
            'REGISTRATION_FAILED',
            `Failed to publish mDNS service: ${this.toErrorMessage(error)}`,
            service.id
        );
    }
  }

  async deregister(serviceId: string): Promise<void> {
    const service = this.publishedServices.get(serviceId);
    if (!service) {
        return; // Idempotent
    }

    return new Promise((resolve, reject) => {
        service.stop((err?: Error | null) => {
            if (err) {
                reject(new ServiceDiscoveryError('DEREGISTRATION_FAILED', err.message, serviceId));
            } else {
                this.publishedServices.delete(serviceId);
                console.log(`[Bonjour] Unpublished service: ${serviceId}`);
                resolve();
            }
        });
    });
  }

  async discover(serviceType: string): Promise<ServiceInstance[]> {
    return new Promise((resolve) => {
        const discovered: ServiceInstance[] = [];
        const browser = this.bonjour.find({ type: this.serviceType }, (service: Service) => {
            if (service.txt && service.txt.type === serviceType) {
                discovered.push(this.mapToInstance(service));
            }
        });
        
        // Wait 1.5s to gather peers then resolve
        setTimeout(() => {
            browser.stop();
            resolve(discovered);
        }, 1500);
    });
  }

  async getInstance(serviceId: string): Promise<ServiceInstance | null> {
      // mDNS doesn't support direct querying by ID efficiently without browsing.
      // We would need to maintain a local cache from a browser.
      // For this MVP, we returning null or scanning.
      return null; 
  }

  watch(serviceType: string, callback: ServiceWatchCallback): () => void {
    // Stop existing browser for this type if any (simplification)
    if (this.browsers.has(serviceType)) {
        this.browsers.get(serviceType)?.stop();
    }

    const browser = this.bonjour.find({ type: this.serviceType });
    
    const instances = new Map<string, ServiceInstance>();

    const notify = () => {
        const filtered = Array.from(instances.values()).filter(i => i.type === serviceType);
        callback(filtered);
    };

    browser.on('up', (service: Service) => {
        if (service.txt && service.txt.type === serviceType) {
            const instance = this.mapToInstance(service);
            instances.set(instance.id, instance);
            notify();
        }
    });

    browser.on('down', (service: Service) => {
         // Identifying service by details since ID is in TXT
         // 'service' object in 'down' event often matches name/type
         // We might need to iterate or check how bonjour-service handles 'down' identity.
         // Usually it passes the service object.
         // We try to find the entry in our map that matches.
         for (const [id, inst] of instances) {
             // Heuristic matching
             if (inst.port === service.port && inst.host === (service.host || service.referer.address)) {
                  instances.delete(id);
             }
         }
         notify();
    });

    this.browsers.set(serviceType, browser);

    return () => {
        browser.stop();
        this.browsers.delete(serviceType);
    };
  }

  async updateMetadata(serviceId: string, metadata: Record<string, string>): Promise<void> {
    // Bonjour services are immutable-ish. We usually re-announce.
    // For MVP: Deregister and Register.
    const service = this.publishedServices.get(serviceId);
    if (!service) throw new ServiceDiscoveryError('UPDATE_FAILED', 'Service not found locally', serviceId);
    
    // We need the original registration data. 
    // Simplified: we assume we can't easily update without full context.
    // In a robust impl, we'd store the full config.
    throw new Error('updateMetadata not implemented for Bonjour (requires re-publish)');
  }

  async heartbeat(serviceId: string): Promise<void> {
    // No-op for mDNS
  }

  isAvailable(): boolean {
    return true;
  }

  getLeaderId(): string | null {
    return null; // No leader in p2p mDNS
  }

  private mapToInstance(service: Service): ServiceInstance {
      const txt = service.txt || {};
      return {
          id: txt.id || uuidv4(), // Fallback if missing
          type: txt.type || 'unknown',
          host: service.host || service.referer?.address || 'unknown',
          port: service.port,
          metadata: txt,
          health: 'HEALTHY', // Assumed healthy if visible
          lastSeen: new Date(),
          registeredAt: new Date(), // Unknown, assume now
      };
  }

  async destroy(): Promise<void> {
      this.bonjour.destroy();
  }
}
