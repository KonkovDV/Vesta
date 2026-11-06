import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express-serve-static-core';
import { rateLimiterMiddleware } from '../../src/application/middleware/rate-limiter.middleware';

function call(ip: string): number {
  let status = 0;
  let passed = false;
  const req = { ip } as Request;
  const res = {
    setHeader() { return this; },
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  const next: NextFunction = () => { passed = true; };
  rateLimiterMiddleware(req, res, next);
  return passed ? 200 : status;
}

test('without TRUST_PROXY a shared address is not banned for ten minutes', () => {
  const previous = process.env.TRUST_PROXY;
  delete process.env.TRUST_PROXY;
  const ip = `203.0.113.${process.pid % 200}`;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 140; i += 1) statuses.push(call(ip));
    assert.equal(statuses.includes(403), false);
    assert.equal(statuses.includes(429), true);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});

test('with TRUST_PROXY the penalty ban applies to that client address', () => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = '1';
  const ip = `203.0.113.${(process.pid % 50) + 50}`;
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 140; i += 1) statuses.push(call(ip));
    assert.equal(statuses.includes(403), true);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
});
