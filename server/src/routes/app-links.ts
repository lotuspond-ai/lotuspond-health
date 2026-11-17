// Universal links (iOS) and verified app links (Android): the files that let the apps claim https links on the
// APP_LINKS_ORIGIN host, and the page that host shows when a link opens in the browser instead of the app.
//
//   GET /.well-known/apple-app-site-association   with APPLE_TEAM_ID
//   GET /.well-known/assetlinks.json              with ANDROID_APP_SHA256
//   GET /accounts-return                          fallback: the same sign-in return, through the app's own scheme
//
// The apps claim only APP_LINK_PATH, so nothing else on the host opens them.
import { Hono } from 'hono';
import { APP_ACCOUNTS_REDIRECT, APP_ID, APP_LINK_PATH } from '../../../shared/identity.ts';
import type { Config } from '../config.ts';

export function appLinkRoutes(config: Config) {
  const app = new Hono();
  const { appleTeamId, androidSha256 } = config.appLinks;
  // Apple's CDN and Android's verifier fetch these without cookies; they must be plain JSON with no redirect.
  const json = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' };

  app.get('/.well-known/apple-app-site-association', c => {
    if (!appleTeamId) return c.notFound();
    return c.body(JSON.stringify({
      applinks: {
        details: [{
          appIDs: [`${appleTeamId}.${APP_ID}`],
          components: [{ '/': APP_LINK_PATH, comment: 'Sign-in with LotusPond Accounts returning to the app' }],
        }],
      },
    }), 200, json);
  });

  app.get('/.well-known/assetlinks.json', c => {
    if (!androidSha256.length) return c.notFound();
    return c.body(JSON.stringify([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: APP_ID, sha256_cert_fingerprints: androidSha256 },
    }]), 200, json);
  });

  // The link opened in the browser, not the app (the app is missing, older, or the OS kept the link): offer the app's
  // own scheme with the same code. The code only works with the verifier the app holds.
  app.get(APP_LINK_PATH, c => {
    const q = c.req.query();
    const params = new URLSearchParams();
    if (q.code && /^[A-Za-z0-9_-]{20,4000}$/.test(q.code)) params.set('code', q.code);
    else if (q.error && /^[a-z_]{1,40}$/.test(q.error)) params.set('error', q.error);
    else params.set('error', 'expired');
    if (q.signed_out === '1') { params.delete('error'); params.set('signed_out', '1'); }
    // The regional host that holds the account, only when it is one this deployment lists (REGION_API_ORIGINS).
    if (params.has('code') && q.api_origin && Object.values(config.regionApiOrigins).includes(q.api_origin)) params.set('api_origin', q.api_origin);
    const href = `${APP_ACCOUNTS_REDIRECT}?${params}`.replace(/&/g, '&amp;');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('X-Robots-Tag', 'noindex');
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open LotusPond Health</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:26rem;margin:4rem auto;padding:0 1rem;color:#12302e;background:#f3f6f5;text-align:center}
a{display:inline-block;margin-top:1rem;padding:.8rem 1.4rem;border-radius:.6rem;background:#b8506d;color:#fff;text-decoration:none}.note{color:#5b6f6c;font-size:.9rem}</style></head>
<body><p>Finish signing in in the LotusPond Health app.</p><a href="${href}">Open LotusPond Health</a>
<p class="note">Nothing happens? Install the app, or update it, then sign in again from the app.</p></body></html>`);
  });

  return app;
}
