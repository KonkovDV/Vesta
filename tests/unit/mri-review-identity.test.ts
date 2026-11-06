import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express-serve-static-core';
import { CompleteMriHumanReviewController } from '../../src/presentation/http/controllers/healthcare/CompleteMriHumanReviewController';
import type { CompleteMriHumanReviewUseCase } from '../../src/application/services/CompleteMriHumanReviewUseCase';
import type { ILogger } from '../../src/core/decorators/ILogger';
import { HumanReviewDisposition } from '../../src/domain/healthcare/value-objects/HumanReviewDisposition';
import { DomainInvariantViolationError } from '../../src/domain/errors/DomainError';

const disposition = {
  reviewerRole: 'Neuroradiologist',
  reviewerId: 'someone-else',
  decision: 'accepted',
  reviewedAt: '2026-11-06T12:00:00.000Z',
};

function response(): { statusCode: number; body: unknown; res: Response } {
  const box = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { box.statusCode = code; return this; },
    json(body: unknown) { box.body = body; return this; },
  } as unknown as Response;
  return {
    get statusCode() { return box.statusCode; },
    get body() { return box.body; },
    res,
  };
}

test('the stored reviewer id is the authenticated user', async () => {
  let reviewerId = '';
  const useCase = {
    async execute(input: { disposition: HumanReviewDisposition }) {
      reviewerId = input.disposition.reviewerId;
      return { caseId: 'case-1', status: 'Reviewed', decision: 'accepted', hasBlockingFlags: false };
    },
  };
  const controller = new CompleteMriHumanReviewController(
    useCase as unknown as CompleteMriHumanReviewUseCase,
    { error() {} } as unknown as ILogger,
  );
  const out = response();
  await controller.handle({
    params: { caseId: 'case-1' },
    body: { disposition },
    headers: {},
    authContext: { userId: 'user-real' },
  } as unknown as Request, out.res);
  assert.equal(out.statusCode, 200);
  assert.equal(reviewerId, 'user-real');
});

test('a review without an authenticated user answers 401', async () => {
  let called = false;
  const useCase = {
    async execute() {
      called = true;
      return { caseId: 'case-1', status: 'Reviewed', decision: 'accepted', hasBlockingFlags: false };
    },
  };
  const controller = new CompleteMriHumanReviewController(
    useCase as unknown as CompleteMriHumanReviewUseCase,
    { error() {} } as unknown as ILogger,
  );
  const out = response();
  await controller.handle({
    params: { caseId: 'case-1' },
    body: { disposition },
    headers: {},
  } as unknown as Request, out.res);
  assert.equal(out.statusCode, 401);
  assert.equal(called, false);
});

test('an empty reviewer id is refused', () => {
  assert.throws(
    () => HumanReviewDisposition.create({
      reviewerRole: 'Neuroradiologist',
      reviewerId: '   ',
      decision: 'accepted',
      reviewedAt: new Date('2026-11-06T12:00:00.000Z'),
    }),
    (error: unknown) => error instanceof DomainInvariantViolationError,
  );
});
