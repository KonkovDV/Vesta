import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express-serve-static-core';
import { IngestionController } from '../../src/presentation/http/controllers/ingestion/IngestionController';
import { ContentIngestionService } from '../../src/memory/ingestion/ContentIngestionService';
import { SsrfBlockedError } from '../../src/infrastructure/security/SsrfDnsGuard';
import { SecurityError } from '../../src/domain/errors/DomainError';

function capture(): { statusCode: number; body: unknown; res: Response } {
  const box = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      box.statusCode = code;
      return this;
    },
    json(body: unknown) {
      box.body = body;
      return this;
    },
  } as unknown as Response;
  return {
    get statusCode() { return box.statusCode; },
    get body() { return box.body; },
    res,
  };
}

function request(body: Record<string, unknown>): Request {
  return { body } as Request;
}

test('a blocked document URL answers 400', async () => {
  const controller = new IngestionController({
    async ingestURL() {
      throw new SsrfBlockedError('127.0.0.1', 'Address in private range: loopback');
    },
    async ingestPDF() { throw new Error('unused'); },
    async ingestImage() { throw new Error('unused'); },
    async ingestText() { throw new Error('unused'); },
    getSupportedTypes() { return []; },
  });
  const out = capture();
  await controller.ingestUrl(request({
    tenantId: 'tenant-1',
    userId: 'user-1',
    url: 'http://127.0.0.1/secret',
  }), out.res);
  assert.equal(out.statusCode, 400);
  assert.match(String((out.body as { error: string }).error), /SSRF blocked/);
});

test('an unexpected ingestion failure stays 500', async () => {
  const controller = new IngestionController({
    async ingestURL() {
      throw new Error('disk full');
    },
    async ingestPDF() { throw new Error('unused'); },
    async ingestImage() { throw new Error('unused'); },
    async ingestText() { throw new Error('unused'); },
    getSupportedTypes() { return []; },
  });
  const out = capture();
  await controller.ingestUrl(request({
    tenantId: 'tenant-1',
    userId: 'user-1',
    url: 'https://example.com/doc',
  }), out.res);
  assert.equal(out.statusCode, 500);
  assert.equal((out.body as { error: string }).error, 'disk full');
});

test('a private document URL is refused before the HTTP client runs', async () => {
  let called = false;
  const service = new ContentIngestionService(
    { async generateText() { return { text: '' }; } },
    undefined,
    {
      async get() {
        called = true;
        return { data: '', status: 200 };
      },
    },
  );
  await assert.rejects(
    () => service.ingestURL({
      tenantId: 'tenant-1',
      userId: 'user-1',
      contentType: 'url',
      url: 'http://127.0.0.1/secret',
    }),
    (error: unknown) => error instanceof SecurityError && error.httpStatusCode === 400,
  );
  assert.equal(called, false);
});
