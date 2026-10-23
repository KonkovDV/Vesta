import {
  getOrCreateCounter,
  getOrCreateGauge,
  getOrCreateHistogram,
} from './registry';

const mriCasesAwaitingReviewGauge = getOrCreateGauge(
  'mri_second_opinion_cases_awaiting_review',
  'MRI second-opinion cases awaiting human review grouped by urgency',
  ['urgency'],
);

const mriReviewWaitStartedAtGauge = getOrCreateGauge(
  'mri_second_opinion_review_wait_started_at_unix',
  'Unix timestamp for the oldest MRI second-opinion case awaiting review by urgency',
  ['urgency'],
);

const mriInferenceRequestsCounter = getOrCreateCounter(
  'mri_second_opinion_inference_requests_total',
  'MRI second-opinion inference requests grouped by provider and result',
  ['provider', 'result'],
);

const mriInferenceLatencyHistogram = getOrCreateHistogram(
  'mri_second_opinion_inference_latency_seconds',
  'MRI second-opinion inference latency in seconds grouped by provider',
  ['provider'],
);

const mriIngestionJobsCounter = getOrCreateCounter(
  'mri_second_opinion_ingestion_jobs_total',
  'MRI second-opinion ingestion jobs grouped by source and result',
  ['source', 'result'],
);

const mriIngestionStageHistogram = getOrCreateHistogram(
  'mri_second_opinion_ingestion_stage_duration_seconds',
  'MRI second-opinion ingestion stage latency in seconds',
  ['stage'],
);

const mriDeliveryJobsCounter = getOrCreateCounter(
  'mri_second_opinion_delivery_jobs_total',
  'MRI second-opinion delivery jobs grouped by result',
  ['result'],
);

const mriDeliveryLatencyHistogram = getOrCreateHistogram(
  'mri_second_opinion_delivery_duration_seconds',
  'MRI second-opinion delivery latency in seconds',
  ['result'],
);

export function recordMriInference(provider: string, result: 'success' | 'failure', latencyMs: number): void {
  mriInferenceRequestsCounter.inc({ provider, result });
  mriInferenceLatencyHistogram.observe({ provider }, latencyMs / 1000);
}

export function recordMriIngestionJob(source: string, result: 'accepted' | 'rejected' | 'failed'): void {
  mriIngestionJobsCounter.inc({ source, result });
}

export function recordMriIngestionStage(stage: string, durationMs: number): void {
  mriIngestionStageHistogram.observe({ stage }, durationMs / 1000);
}

export function recordMriDeliveryJob(result: 'success' | 'failure', durationMs: number): void {
  mriDeliveryJobsCounter.inc({ result });
  mriDeliveryLatencyHistogram.observe({ result }, durationMs / 1000);
}

export function setMriCasesAwaitingReview(urgency: 'routine' | 'urgent' | 'stat', count: number): void {
  mriCasesAwaitingReviewGauge.set({ urgency }, count);
}

export function setMriReviewWaitStartedAt(
  urgency: 'routine' | 'urgent' | 'stat',
  timestampMs: number,
): void {
  mriReviewWaitStartedAtGauge.set({ urgency }, Math.floor(timestampMs / 1000));
}