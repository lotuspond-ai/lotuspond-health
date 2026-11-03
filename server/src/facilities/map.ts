// Map tile settings for the Labs page (GET /api/config), and the hosts the page's CSP must allow for them.
import type { MapSettings } from '../../../shared/types.ts';
import type { Config } from '../config.ts';

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_LINK = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

/** PMTiles (self-hosted Protomaps basemap) first, then a MapLibre style URL, then OpenStreetMap raster tiles. */
export function mapSettings(config: Config): MapSettings {
  const m = config.map;
  if (m.pmtilesUrl) {
    return { type: 'pmtiles', url: m.pmtilesUrl, assetsUrl: m.assetsUrl, attribution: `<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> ${OSM_LINK}` };
  }
  if (m.styleUrl) return { type: 'style', url: m.styleUrl };
  return { type: 'raster', tiles: [OSM_TILES], attribution: OSM_LINK, maxZoom: 19 };
}

function origin(url: string | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null; // relative paths are served by this server ('self')
  try {
    return new URL(url.replace(/\{[^}]+\}/g, '0')).origin;
  } catch {
    return null;
  }
}

export interface CspSources {
  img: string[];
  connect: string[];
}

/**
 * Extra Content-Security-Policy sources the configured map needs. Vector tiles, glyphs and styles are fetched
 * (connect-src); raster tiles and sprites are images (img-src, and connect-src because MapLibre fetches them).
 * A MAP_STYLE_URL may itself point at further hosts; list those in the style's own server or self-host them.
 */
export function mapCspSources(config: Config): CspSources {
  const s = mapSettings(config);
  const urls = s.type === 'pmtiles' ? [s.url, s.assetsUrl] : s.type === 'style' ? [s.url] : s.tiles;
  const hosts = [...new Set(urls.map(origin).filter((o): o is string => !!o))];
  return { img: hosts, connect: hosts };
}

/** Add sources to a policy's img-src and connect-src directives. */
export function addCspSources(policy: string, extra: CspSources): string {
  if (!extra.img.length && !extra.connect.length) return policy;
  return policy.split(';').map(d => {
    const directive = d.trim();
    const name = directive.split(/\s+/)[0];
    const add = name === 'img-src' ? extra.img : name === 'connect-src' ? extra.connect : [];
    const missing = add.filter(h => !directive.split(/\s+/).includes(h));
    return missing.length ? `${directive} ${missing.join(' ')}` : directive;
  }).join('; ');
}
