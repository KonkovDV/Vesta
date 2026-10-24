import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SsrfDnsGuard, type PinnedEndpoint } from '../../src/infrastructure/security/SsrfDnsGuard';
import { createPinnedFetch, pinnedExchange } from '../../src/infrastructure/http/SsrfPinnedHttpClient';

const blocked = [
  'http://127.0.0.1/', 'http://127.1/', 'http://0x7f000001/', 'http://169.254.169.254/latest/meta-data/',
  'http://10.1.2.3/', 'http://100.64.0.1/', 'http://198.18.0.1/', 'http://192.0.0.170/', 'http://0.0.0.0/',
  'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/',
  'http://[64:ff9b::7f00:1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[::127.0.0.1]/', 'http://[2002:7f00:1::]/',
  'http://[2001::1]/', 'http://[fec0::1]/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://[ff02::1]/',
  'http://[2001:db8::1]/', 'http://[100::1]/',
];

test('IPv6 literals that reach private IPv4 or special ranges are blocked even when IPv6 is allowed', async () => {
  const guard = new SsrfDnsGuard({ blockIpv6: false });
  for (const url of blocked) {
    await assert.rejects(guard.pinUrl(url), /SSRF blocked/, url);
  }
});

test('public literals pass, including NAT64 to a public IPv4', async () => {
  const guard = new SsrfDnsGuard({ blockIpv6: false });
  for (const url of ['http://93.184.215.14/', 'http://[2606:4700:4700::1111]/', 'http://[64:ff9b::5db8:d70e]/']) {
    const pinned = await guard.pinUrl(url);
    assert.equal(pinned.addresses.length, 1, url);
  }
});

test('IPv6 stays blocked by default', async () => {
  await assert.rejects(new SsrfDnsGuard().pinUrl('http://[2606:4700:4700::1111]/'), /IPv6/);
});

function loopbackGuard() {
  return {
    async pinUrl(url: string): Promise<PinnedEndpoint> {
      const parsed = new URL(url);
      return {
        protocol: parsed.protocol as 'http:',
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: `${parsed.pathname}${parsed.search}`,
        hostHeader: parsed.host,
        addresses: ['127.0.0.1'],
      };
    },
  };
}

async function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('pinnedExchange stops reading past maxBytes', async () => {
  const server = await listen((_req, res) => { res.end(Buffer.alloc(64 * 1024, 'a')); });
  try {
    await assert.rejects(
      pinnedExchange(loopbackGuard(), { method: 'GET', url: `${server.url}/big`, timeoutMs: 2000, maxBytes: 1024 }),
      /exceeds 1024 bytes/,
    );
  } finally {
    await server.close();
  }
});

test('createPinnedFetch drops Authorization on a cross-origin redirect', async () => {
  let seen: string | undefined = 'unset';
  const target = await listen((req, res) => { seen = req.headers.authorization; res.end('ok'); });
  const origin = await listen((_req, res) => { res.writeHead(302, { location: `${target.url}/landing` }); res.end(); });
  try {
    const pinnedFetch = createPinnedFetch(loopbackGuard());
    const response = await pinnedFetch(`${origin.url}/start`, { headers: { Authorization: 'Bearer secret' } });
    assert.equal(await response.text(), 'ok');
    assert.equal(seen, undefined);
  } finally {
    await target.close();
    await origin.close();
  }
});
