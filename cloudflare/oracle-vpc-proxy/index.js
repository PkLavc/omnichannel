const INTERNAL_ORIGIN = 'http://public-router:8080';
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function buildOriginRequest(request) {
  const publicUrl = new URL(request.url);
  const target = new URL(publicUrl.pathname + publicUrl.search, INTERNAL_ORIGIN);
  const headers = new Headers(request.headers);
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.set('x-forwarded-host', publicUrl.host);
  headers.set('x-forwarded-proto', 'https');
  const init = { method: request.method, headers, redirect: 'manual' };
  if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
  return new Request(target, init);
}

function rewriteLocation(value, publicUrl) {
  if (!value) return value;
  try {
    const location = new URL(value, INTERNAL_ORIGIN);
    if (location.origin === new URL(INTERNAL_ORIGIN).origin) {
      return `${publicUrl.origin}${location.pathname}${location.search}${location.hash}`;
    }
  } catch (_) {}
  return value;
}

async function proxy(request, env) {
  if (!env.ORACLE || typeof env.ORACLE.fetch !== 'function') {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: SECURITY_HEADERS });
  }
  const publicUrl = new URL(request.url);
  try {
    const response = await env.ORACLE.fetch(buildOriginRequest(request));
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    const location = headers.get('location');
    if (location) headers.set('location', rewriteLocation(location, publicUrl));
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (_) {
    return Response.json({ status: 'unavailable' }, {
      status: 503,
      headers: { ...SECURITY_HEADERS, 'Retry-After': '30' },
    });
  }
}

export default { fetch: proxy };
export const __test = { buildOriginRequest, rewriteLocation };
