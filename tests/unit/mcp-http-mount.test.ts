import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import { AppServer } from '../../src/infrastructure/http/AppServer';
import {
  MCP_HTTP_AGENT_ID,
  mcpHttpAccessContext,
  mountMcpHttp,
} from '../../src/infrastructure/http/mcp-http-mount';
import type { IMcpServer } from '../../src/domain/mcp/IMcpServer';

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('the URL name researcher-x is not the tool-policy agent id', () => {
  const access = mcpHttpAccessContext({
    authContext: { scopes: ['agents.run'] },
  });
  assert.equal(access.agentId, MCP_HTTP_AGENT_ID);
  assert.equal(access.agentId, 'mcp-http-client');
  assert.deepEqual(access.grantedScopes, ['agents.run']);
});

test('the kernel HTTP server does not attach /api/mcp after the application', async () => {
  const app = express();
  app.use((_req, res) => {
    res.status(404).json({ title: 'Not Found' });
  });
  const http = new AppServer({ createApp: async () => ({ app }) });
  const started = await http.start({ port: 0, host: '127.0.0.1', logStart: false });
  try {
    const response = await fetch(`http://127.0.0.1:${started.port}/api/mcp/researcher-x/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404);
  } finally {
    await http.stop();
  }
});

test('mountMcpHttp answers 401 on /api/mcp/researcher-x when it is mounted before 404', async () => {
  const app = express();
  const transport = mountMcpHttp(app, {
    server: {} as IMcpServer,
    authenticator: {
      async authenticateRequest() {
        throw new Error('missing api key');
      },
    },
  });
  app.use((_req, res) => {
    res.status(404).json({ title: 'Not Found' });
  });
  const server = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp/researcher-x/user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 401);
  } finally {
    await close(server);
    await transport.close();
  }
});
