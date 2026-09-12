import { describe, expect, test } from 'bun:test';
import { registryWorker } from './worker';

function assets(): { fetch(request: Request): Promise<Response> } {
  return {
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (
        pathname === '/v1/index.json' ||
        pathname === '/v2/index.json' ||
        pathname === '/v3/index.json'
      ) {
        return new Response('{"entries":[]}', { status: 200 });
      }
      if (
        pathname.startsWith('/v1/artifacts/') ||
        pathname.startsWith('/v2/artifacts/') ||
        pathname.startsWith('/v3/artifacts/')
      ) {
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
    for (const version of ['v1', 'v2', 'v3']) {
      const response = await request(`/${version}/index.json`);

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(
        'public, max-age=60, s-maxage=60, must-revalidate',
      );
    }
  });

  test('serves versioned artifacts as immutable assets', async () => {
    for (const version of ['v1', 'v2', 'v3']) {
      const response = await request(
        `/${version}/artifacts/alvin/test/1.0.0.json`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(
        'public, max-age=31536000, immutable',
      );
    }

    const avatar = await request(
      '/v3/artifacts/alvin/janitor/1.0.0.webp',
    );
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('Cache-Control')).toBe(
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
    const invalidVersion = await registryWorker.fetch(
      new Request('https://registry.ohmyopencodeslim.com/v4/index.json'),
      env,
    );
    const invalidHost = await registryWorker.fetch(
      new Request('https://example.com/v1/index.json'),
      env,
    );

    expect(invalidPrefix.status).toBe(404);
    expect(invalidVersion.status).toBe(404);
    expect(invalidHost.status).toBe(404);
    expect(calls).toBe(0);
  });

  test('passes all versioned roots to the shared dist asset root', async () => {
    const paths: string[] = [];
    const env = {
      ASSETS: {
        async fetch(assetRequest: Request) {
          paths.push(new URL(assetRequest.url).pathname);
          return new Response('ok');
        },
      },
    };

    await registryWorker.fetch(
      new Request('https://registry.ohmyopencodeslim.com/v1/index.json'),
      env,
    );
    await registryWorker.fetch(
      new Request('https://registry.ohmyopencodeslim.com/v2/index.json'),
      env,
    );
    await registryWorker.fetch(
      new Request('https://registry.ohmyopencodeslim.com/v3/index.json'),
      env,
    );

    expect(paths).toEqual(['/v1/index.json', '/v2/index.json', '/v3/index.json']);
  });

  test('preserves the asset path and query string for every version', async () => {
    const requests: Array<{ pathname: string; search: string }> = [];
    const env = {
      ASSETS: {
        async fetch(assetRequest: Request) {
          const assetUrl = new URL(assetRequest.url);
          requests.push({
            pathname: assetUrl.pathname,
            search: assetUrl.search,
          });
          return new Response('ok');
        },
      },
    };

    await registryWorker.fetch(
      new Request(
        'https://registry.ohmyopencodeslim.com/v1/artifacts/alvin/test/1.0.0.json?cache_bust=one',
      ),
      env,
    );
    await registryWorker.fetch(
      new Request(
        'https://registry.ohmyopencodeslim.com/v2/artifacts/alvin/test/1.0.0.json?cache_bust=two',
      ),
      env,
    );
    await registryWorker.fetch(
      new Request(
        'https://registry.ohmyopencodeslim.com/v3/artifacts/alvin/test/1.0.0.json?cache_bust=three',
      ),
      env,
    );

    expect(requests).toEqual([
      {
        pathname: '/v1/artifacts/alvin/test/1.0.0.json',
        search: '?cache_bust=one',
      },
      {
        pathname: '/v2/artifacts/alvin/test/1.0.0.json',
        search: '?cache_bust=two',
      },
      {
        pathname: '/v3/artifacts/alvin/test/1.0.0.json',
        search: '?cache_bust=three',
      },
    ]);
  });
});
