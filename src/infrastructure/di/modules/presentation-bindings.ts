/**
 * Binds presentation routes and controllers after application use cases exist.
 * The application layer does not import this module.
 */
import type { DIContainer } from '../../../core/di/container';
import type { ILogger } from '../../../core/decorators/ILogger';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { ApplicationServiceTokens } from '../../../application/di/bootstrap';
import type { HttpRouteRegistrar } from '../../../application/app';
import { registerDefaultHttpRoutes } from '../../../presentation/http/register-default-routes';

function createFallbackLogger(): ILogger {
  return {
    log: () => {},
    error: console.error,
    warn: () => {},
    debug: () => {},
    info: () => {},
  };
}

export function registerPresentationBindings(container: DIContainer): void {
  if (!container.isRegistered('HttpRouteRegistrar')) {
    container.register<HttpRouteRegistrar>(
      'HttpRouteRegistrar',
      () => registerDefaultHttpRoutes,
      { lifecycle: 'singleton', tags: ['http'], description: 'Default HTTP route registrar' },
    );
  }

  if (!container.isRegistered('LeadScoringController')) {
    container.register(
      'LeadScoringController',
      (c) => {
        const { LeadScoringController } = require('../../../presentation/http/controllers/sales/LeadScoringController') as typeof import('../../../presentation/http/controllers/sales/LeadScoringController');
        return new LeadScoringController(
          c.resolve(ApplicationServiceTokens.LEAD_SCORING),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'sales'] },
    );
  }

  if (!container.isRegistered('SalesForecastingController')) {
    container.register(
      'SalesForecastingController',
      (c) => {
        const { SalesForecastingController } = require('../../../presentation/http/controllers/sales/SalesForecastingController') as typeof import('../../../presentation/http/controllers/sales/SalesForecastingController');
        return new SalesForecastingController(
          c.resolve(ApplicationServiceTokens.SALES_FORECASTING),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'sales'] },
    );
  }

  if (!container.isRegistered('TalentAcquisitionController')) {
    container.register(
      'TalentAcquisitionController',
      (c) => {
        const { TalentAcquisitionController } = require('../../../presentation/http/controllers/hr/TalentAcquisitionController') as typeof import('../../../presentation/http/controllers/hr/TalentAcquisitionController');
        return new TalentAcquisitionController(
          c.resolve(ApplicationServiceTokens.TALENT_ACQUISITION),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'hr'] },
    );
  }

  if (!container.isRegistered('EmployeeEngagementController')) {
    container.register(
      'EmployeeEngagementController',
      (c) => {
        const { EmployeeEngagementController } = require('../../../presentation/http/controllers/hr/EmployeeEngagementController') as typeof import('../../../presentation/http/controllers/hr/EmployeeEngagementController');
        return new EmployeeEngagementController(
          c.resolve(ApplicationServiceTokens.EMPLOYEE_ENGAGEMENT),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'hr'] },
    );
  }

  if (!container.isRegistered('DiagnosisSupportController')) {
    container.register(
      'DiagnosisSupportController',
      (c) => {
        const { DiagnosisSupportController } = require('../../../presentation/http/controllers/healthcare/DiagnosisSupportController') as typeof import('../../../presentation/http/controllers/healthcare/DiagnosisSupportController');
        return new DiagnosisSupportController(
          c.resolve(ApplicationServiceTokens.DIAGNOSIS_SUPPORT),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'healthcare'] },
    );
  }

  if (!container.isRegistered('GenerateMriSecondOpinionController')) {
    container.register(
      'GenerateMriSecondOpinionController',
      (c) => {
        const { GenerateMriSecondOpinionController } = require('../../../presentation/http/controllers/healthcare/GenerateMriSecondOpinionController') as typeof import('../../../presentation/http/controllers/healthcare/GenerateMriSecondOpinionController');
        return new GenerateMriSecondOpinionController(
          c.resolve(ApplicationServiceTokens.GENERATE_MRI_SECOND_OPINION),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'healthcare', 'mri'] },
    );
  }

  if (!container.isRegistered('CompleteMriHumanReviewController')) {
    container.register(
      'CompleteMriHumanReviewController',
      (c) => {
        const { CompleteMriHumanReviewController } = require('../../../presentation/http/controllers/healthcare/CompleteMriHumanReviewController') as typeof import('../../../presentation/http/controllers/healthcare/CompleteMriHumanReviewController');
        return new CompleteMriHumanReviewController(
          c.resolve(ApplicationServiceTokens.COMPLETE_MRI_HUMAN_REVIEW),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'healthcare', 'mri'] },
    );
  }

  if (!container.isRegistered('FinalizeMriSecondOpinionController')) {
    container.register(
      'FinalizeMriSecondOpinionController',
      (c) => {
        const { FinalizeMriSecondOpinionController } = require('../../../presentation/http/controllers/healthcare/FinalizeMriSecondOpinionController') as typeof import('../../../presentation/http/controllers/healthcare/FinalizeMriSecondOpinionController');
        return new FinalizeMriSecondOpinionController(
          c.resolve(ApplicationServiceTokens.FINALIZE_MRI_SECOND_OPINION),
          c.isRegistered(DI_TOKENS.ILogger) ? c.resolve<ILogger>(DI_TOKENS.ILogger) : createFallbackLogger(),
        );
      },
      { lifecycle: 'singleton', tags: ['controller', 'http', 'healthcare', 'mri'] },
    );
  }
}
