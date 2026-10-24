import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpToolConsumerAdapter } from '../../src/infrastructure/mcp/McpToolConsumerAdapter';

class Probe extends McpToolConsumerAdapter {
  transportFor(url: string) {
    return this.createTransport({ transport: 'streamable-http', url } as never);
  }
}

test('outbound MCP over HTTP asks the SSRF guard before it opens a socket (MP-K10)', async () => {
  const asked: string[] = [];
  const guard = { async pinUrl(url: string): Promise<never> { asked.push(url); throw new Error('SSRF blocked: probe'); } };
  const adapter = new Probe({ info() {}, warn() {}, error() {}, debug() {}, log() {} } as never, {} as never, undefined, guard);
  const transport = adapter.transportFor('http://169.254.169.254/mcp') as unknown as { send(message: unknown): Promise<void> };
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  assert.equal(asked[0], 'http://169.254.169.254/mcp');
});
