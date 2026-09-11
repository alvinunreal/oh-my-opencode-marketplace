interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

const REGISTRY_HOST = 'registry.ohmyopencodeslim.com';
const REGISTRY_PREFIX = '/v1/';
const IMMUTABLE_ARTIFACT = /^\/v1\/artifacts\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}\/[0-9A-Za-z.+-]+\.json$/;

function cacheControl(pathname: string): string {
  return IMMUTABLE_ARTIFACT.test(pathname)
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=60, s-maxage=60, must-revalidate';
}

export const registryWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== REGISTRY_HOST || !url.pathname.startsWith(REGISTRY_PREFIX)) {
      return new Response('Not found', { status: 404 });
    }

    const assetUrl = new URL(url);
    assetUrl.pathname = url.pathname.slice('/v1'.length) || '/';
    const assetRequest = new Request(assetUrl, request);
    const response = await env.ASSETS.fetch(assetRequest);
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
