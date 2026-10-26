'use strict';

const { installRoutePathCapture, walkExpressStack } = require('../../scripts/ci-gates-lib.cjs');

installRoutePathCapture();
const express = require('express');

const app = express();
const healthcare = express.Router();
healthcare.post('/mri/:caseId/review', (_req, res) => res.end());
app.use('/api/v1/healthcare', (_req, _res, next) => next(), healthcare);
app.get('/health', (_req, res) => res.end());

const stack = (app.router || app._router).stack;
const walked = walkExpressStack(stack);
if (walked.misses.length > 0) {
  console.error(`misses ${walked.misses.join(',')}`);
  process.exit(1);
}
const keys = walked.routes.map((route) => `${route.method} ${route.path}`).sort();
console.log(keys.join('\n'));
if (!keys.includes('POST /api/v1/healthcare/mri/:caseId/review')) process.exit(1);
if (!keys.includes('GET /health')) process.exit(1);
if (keys.some((key) => key.startsWith('HEAD '))) process.exit(1);
