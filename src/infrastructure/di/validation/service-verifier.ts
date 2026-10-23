/**
 * Health/availability verification helpers extracted from bootstrap.ts.
 */
import { container } from '../../../core/di/container';
import { getConfig } from '../../../config';

interface HealthcheckableService {
  isHealthy?: () => Promise<boolean> | boolean;
  isAvailable?: () => Promise<boolean> | boolean;
}

async function checkWithTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operationName} timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function verifyCriticalInfrastructureServices(): Promise<void> {
  console.log('🔍 Verifying service availability...');
  const cfg = getConfig();
  const isTestEnv = cfg.NODE_ENV === 'test';
  const services = [
    { name: 'AI Client', token: 'IAIClient', optional: isTestEnv },
    { name: 'Database', token: 'IDatabaseConnection', optional: isTestEnv },
    { name: 'Cache', token: 'ICache', optional: false },
    { name: 'File Storage', token: 'IFileStorage', optional: true },
    { name: 'Event Store', token: 'IEventStore', optional: isTestEnv },
    { name: 'Event Bus', token: 'IEventBus', optional: isTestEnv },
    {
      name: 'Outbox',
      token: 'IOutbox',
      optional: isTestEnv || cfg.NODE_ENV === 'development',
    },
  ] as const;

  // Independent probes overlap. A required failure still rejects the startup.
  const results = await Promise.allSettled(services.map((service) => checkService(service)));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    throw failure.reason;
  }
}

async function checkService(service: {
  name: string;
  token: string;
  optional: boolean;
}): Promise<void> {
  console.log(`Checking ${service.name}...`);
  try {
    if (!container.isRegistered(service.token)) {
      if (!service.optional) {
        console.warn(`⚠ ${service.name} not registered`);
      }
      return;
    }

    const instance = container.resolve<HealthcheckableService>(service.token);
    const warmable = instance as HealthcheckableService & { warmup?: () => Promise<boolean> };
    if (typeof warmable.warmup === 'function') {
      try {
        const warm = await checkWithTimeout(
          Promise.resolve(warmable.warmup()),
          5000,
          `${service.name} warmup`,
        );
        console.log(`${warm ? '✓' : '⚠'} ${service.name} pool: ${warm ? 'warm' : 'not warmed'}`);
      } catch (error) {
        console.warn(`⚠ ${service.name} pool was not warmed`, error);
      }
    }

    if (typeof instance.isHealthy === 'function') {
      const healthy = await checkWithTimeout(
        Promise.resolve(instance.isHealthy()),
        5000,
        `${service.name} health check`,
      );
      console.log(`${healthy ? '✓' : '⚠'} ${service.name} health: ${healthy ? 'OK' : 'Not healthy'}`);
      if (!healthy && !service.optional) {
        throw new Error(`${service.name} is not healthy`);
      }
      return;
    }

    if (typeof instance.isAvailable === 'function') {
      const available = await checkWithTimeout(
        Promise.resolve(instance.isAvailable()),
        5000,
        `${service.name} availability check`,
      );
      console.log(`${available ? '✓' : '⚠'} ${service.name} availability: ${available ? 'OK' : 'Not available'}`);
      if (!available && !service.optional) {
        throw new Error(`${service.name} is not available`);
      }
      return;
    }

    console.log(`✓ ${service.name} registered (no health/availability check)`);
  } catch (error) {
    console.error(`✗ ${service.name} verification failed:`, error);
    if (!service.optional) {
      throw error;
    }
  }
}
