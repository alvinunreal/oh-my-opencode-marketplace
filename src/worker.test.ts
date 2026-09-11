import { describe, expect, test } from 'bun:test';
import { registryWorker } from './worker';

function assets(): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/index.json') {
        return new Response('{"entries":[]}', { status: 200 });
      }
      if (pathname.startsWith('/artifacts/')) {
        return new Response('{"manifest":{}}', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    },
  };
}

async function request(path: string, host = 'registry.ohmyopencodeslim.com') {
  return registryWorker.fetch(
    new Request(`https://${host}${path}`),
    { ASSETS: assets() },
  );
}

describe('registry Worker routing', () => {
  test('serves catalog output with short-lived cache headers', async () => {
    const response = await request('/v1/index.json');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=60, s-maxage=60, must-revalidate',
    );
  });

  test('serves versioned artifacts as immutable assets', async () => {
    const response = await request(
      '/v1/artifacts/alvin/deepwork-recon/0.1.0-beta.1.json',
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable',
    );
  });

  test('rejects invalid prefixes and hosts without touching assets', async () => {
    let calls = 0;
    const env = {
      ASSETS: {
        async fetch() {
          calls += 1;
          return new Response('unexpected');
        },
      },
    };

    const invalidPrefix = await registryWorker.fetch(
      new Request('https://registry.ohmyopencodeslim.com/other/index.json'),
      env,
    );
    const invalidHost = await registryWorker.fetch(
      new Request('https://example.com/v1/index.json'),
      env,
    );

    expect(invalidPrefix.status).toBe(404);
    expect(invalidHost.status).toBe(404);
    expect(calls).toBe(0);
  });
});
