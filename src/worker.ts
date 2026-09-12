interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const REGISTRY_HOST = 'registry.ohmyopencodeslim.com';
const REGISTRY_PREFIXES = ['/v1/', '/v2/'] as const;
const IMMUTABLE_ARTIFACT = /^\/v[12]\/artifacts\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}\/[0-9A-Za-z.+-]+\.json$/;

function assetRequest(url: URL, request: Request): Request {
  // The assets directory is dist/, so the version prefix is part of the
  // asset key. Keep both pathname and search intact: the former selects the
  // asset and the latter is intentionally available to the assets cache.
  return new Request(url, request);
}

function cacheControl(pathname: string): string {
  return IMMUTABLE_ARTIFACT.test(pathname)
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=60, s-maxage=60, must-revalidate';
}

export const registryWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const prefix = REGISTRY_PREFIXES.find((candidate) =>
      url.pathname.startsWith(candidate),
    );
    if (url.hostname !== REGISTRY_HOST || !prefix) {
      return new Response('Not found', { status: 404 });
    }

    const response = await env.ASSETS.fetch(assetRequest(url, request));
    if (!response.ok) return response;

    const headers = new Headers(response.headers);
    headers.set('Cache-Control', cacheControl(url.pathname));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export default registryWorker;
