/**
 * Research Use Cases DI Registration
 * Layer: Application
 *
 * Регистрация Research Use Cases в DI контейнере.
 */

import type { DIContainer } from '../../core/di/public-types';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import { ApplicationServiceTokens } from './bootstrap';

/**
 * Регистрация Research Use Cases
 *
 * Требует наличия в контейнере:
 * - 'IResearchReportRepository' (регистрируется в Infrastructure)
 * - 'IArticleFinder', 'IArticleSummarizer', 'ITrendAnalyzer' (регистрируются в Infrastructure)
 * - 'IEventStore' (регистрируется в Infrastructure)
 * - 'ISessionMemoryManager' (регистрируется в Infrastructure)
 * - 'IUnifiedPluginRegistry' (регистрируется в Infrastructure)
 */
export function registerResearchUseCases(container: DIContainer): void {
  if (!container.isRegistered(ApplicationServiceTokens.RESEARCH_ASSISTANCE)) {
    container.register(
      ApplicationServiceTokens.RESEARCH_ASSISTANCE,
      (c) => {
        const reportRepository = c.resolve(DI_TOKENS.IResearchReportRepository);
        const articleFinder = c.resolve('IArticleFinder');
        const articleSummarizer = c.resolve('IArticleSummarizer');
        const trendAnalyzer = c.resolve('ITrendAnalyzer');
        const sessionManager = c.resolve(DI_TOKENS.ISessionMemoryManager);
        const pluginRegistry = c.resolve(DI_TOKENS.IUnifiedPluginRegistry);
        const { ResearchAssistanceUseCase } = require('../usecases/education/ResearchAssistanceUseCase');
        return new ResearchAssistanceUseCase(
          reportRepository,
          articleFinder,
          articleSummarizer,
          trendAnalyzer,
          sessionManager,
          pluginRegistry
        );
      },
      {
        lifecycle: 'transient',
        tags: ['usecase', 'research', 'education'],
        description: 'Research assistance use case with rich domain model',
      },
    );
  }
}
