/**
 * Application-layer DI module glue.
 * Делегирует регистрацию application-сервисов в их собственный bootstrap,
 * сохраняя infrastructure/bootstrap.ts в роли оркестратора.
 */
import { container } from '../../../core/di/container';
import { registerPresentationBindings } from './presentation-bindings';

export function registerApplicationServices(): void {
  try {
     
    const { bootstrapApplicationLayer } = require('../../../application/di/bootstrap') as typeof import('../../../application/di/bootstrap');
    if (typeof bootstrapApplicationLayer !== 'function') {
      throw new Error('[application.module] bootstrapApplicationLayer not exported');
    }

    bootstrapApplicationLayer(container);
    registerPresentationBindings(container);
    console.log('✓ Application services registered');
  } catch (error) {
    console.error('✗ Failed to register application services:', error);
    throw error;
  }
}
