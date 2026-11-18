// The map on the Find a lab page (MapLibre GL, loaded only with this page). Markers are coloured by kind,
// partner labs are larger with a lotus ring, and the selected facility is raised and centred.
// Tiles come from GET /api/config: a self-hosted Protomaps PMTiles file, a style URL, or OpenStreetMap raster tiles.
import { useEffect, useRef, useState } from 'react';
import { addProtocol, AttributionControl, LngLatBounds, Map as MapLibre, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import type { Facility, MapSettings } from '../../types';
import { boundingBox } from '../../../shared/facilities';
import { iconSvg } from './icons';
import { isPartner, KIND } from './meta';

setWorkerUrl(workerUrl);
let pmtilesReady = false;

const BACKGROUND = '#eaf0e3';
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function styleFor(settings: MapSettings | null): StyleSpecification | string {
  const background = { id: 'background', type: 'background' as const, paint: { 'background-color': BACKGROUND } };
  if (settings?.type === 'style') return settings.url;
  if (settings?.type === 'pmtiles') {
    if (!pmtilesReady) {
      const protocol = new Protocol();
      addProtocol('pmtiles', protocol.tile as Parameters<typeof addProtocol>[1]);
      pmtilesReady = true;
    }
    const url = new URL(settings.url, location.href).href;
    const assets = new URL(settings.assetsUrl.replace(/\/?$/, '/'), location.href).href;
    return {
      version: 8,
      glyphs: `${assets}fonts/{fontstack}/{range}.pbf`,
      sprite: `${assets}sprites/v4/light`,
      sources: { protomaps: { type: 'vector', url: `pmtiles://${url}`, attribution: settings.attribution } },
      layers: layers('protomaps', namedFlavor('light'), { lang: document.documentElement.lang || 'en' }) as StyleSpecification['layers'],
    };
  }
  if (settings?.type === 'raster') {
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles: settings.tiles, tileSize: 256, maxzoom: settings.maxZoom, attribution: settings.attribution } },
      // Softened so the coloured markers stand out, in keeping with the misty palette.
      layers: [background, { id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': -0.45, 'raster-brightness-min': 0.06, 'raster-contrast': -0.08 } }],
    };
  }
  return { version: 8, sources: {}, layers: [background] };
}

/** Polygon approximating the search radius. */
function circle(lat: number, lon: number, km: number) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lon + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
  }
  return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [pts] } };
}

function markerElement(f: Facility, onSelect: (id: string) => void): HTMLElement {
  const el = document.createElement('div');
  el.className = `fmarker fmarker--${f.kind}${isPartner(f) ? ' fmarker--partner' : ''}`;
  el.style.setProperty('--kind', KIND[f.kind].color);
  el.innerHTML = `<span class="fmarker__pin">${iconSvg(f.kind)}</span>${isPartner(f) ? `<span class="fmarker__star">${iconSvg('star')}</span>` : ''}`;
  // The list is the keyboard path to every facility; markers are for pointing and tapping.
  el.setAttribute('aria-hidden', 'true');
  el.title = f.name;
  el.addEventListener('click', e => { e.stopPropagation(); onSelect(f.id); });
  return el;
}

export default function FacilityMap({ settings, center, radiusKm, facilities, selectedId, onSelect, label }: {
  settings: MapSettings | null;
  center: { lat: number; lon: number };
  radiusKm: number;
  facilities: Facility[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const markers = useRef(new Map<string, { marker: Marker; el: HTMLElement; f: Facility }>());
  const here = useRef<Marker | null>(null);
  const select = useRef(onSelect);
  /** The map exists (markers and the view can be set); the style has loaded (layers can be added). */
  const [ready, setReady] = useState(false);
  const [styled, setStyled] = useState(false);
  const view = useRef<{ bounds: LngLatBounds | null; userMoved: boolean }>({ bounds: null, userMoved: false });
  const [tileTrouble, setTileTrouble] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { select.current = onSelect; }, [onSelect]);
  // The map is created once with these; the effects further down apply later changes.
  const initial = useRef({ settings, center, radiusKm });

  useEffect(() => {
    if (!box.current) return;
    const { settings, center, radiusKm } = initial.current;
    let m: MapLibre;
    try {
      m = new MapLibre({
        container: box.current,
        style: styleFor(settings),
        center: [center.lon, center.lat],
        zoom: 13,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxZoom: 19,
        transformRequest: url => (/^https:\/\/tile\.openstreetmap\.org\//.test(url) ? { url, referrerPolicy: 'strict-origin-when-cross-origin' } : { url }),
      });
    } catch {
      queueMicrotask(() => setFailed(true)); // no WebGL on this device
      return;
    }
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    // Markers do not need the style; the radius ring does. Neither waits for tiles, which may never arrive.
    m.once('style.load', () => {
      m.addSource('radius', { type: 'geojson', data: circle(center.lat, center.lon, radiusKm) });
      m.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#55694a', 'fill-opacity': 0.05 } });
      m.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#55694a', 'line-opacity': 0.45, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
      setStyled(true);
    });
    m.on('movestart', e => { if ((e as { originalEvent?: Event }).originalEvent) view.current.userMoved = true; });
    m.on('error', e => {
      const sourceId = (e as { sourceId?: string }).sourceId;
      if (sourceId && sourceId !== 'radius') setTileTrouble(true);
    });
    m.on('click', () => select.current(null));
    map.current = m;
    queueMicrotask(() => setReady(true));
    // Keep the whole search circle in view as the layout changes, until the person pans or zooms.
    const resize = new ResizeObserver(() => {
      m.resize();
      const { bounds, userMoved } = view.current;
      if (bounds && !userMoved) m.fitBounds(bounds, { padding: 16, duration: 0 });
    });
    resize.observe(box.current);
    const owned = markers.current;
    return () => {
      resize.disconnect();
      owned.clear();
      here.current = null;
      m.remove();
      map.current = null;
    };
  }, []);

  // The radius ring.
  useEffect(() => {
    if (styled) (map.current?.getSource('radius') as GeoJSONSource | undefined)?.setData(circle(center.lat, center.lon, radiusKm));
  }, [center.lat, center.lon, radiusKm, styled]);

  // The searched point and the view.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (!here.current) {
      const el = document.createElement('div');
      el.className = 'fmarker-here';
      el.setAttribute('aria-hidden', 'true');
      here.current = new Marker({ element: el }).setLngLat([center.lon, center.lat]).addTo(m);
    }
    here.current.setLngLat([center.lon, center.lat]);
    const b = boundingBox(center.lat, center.lon, radiusKm);
    const bounds = new LngLatBounds([b.west, b.south], [b.east, b.north]);
    view.current = { bounds, userMoved: false };
    m.fitBounds(bounds, { padding: 16, duration: reducedMotion() ? 0 : 600 });
  }, [center.lat, center.lon, radiusKm, ready]);

  // Markers: add new, remove gone.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const wanted = new Map(facilities.map(f => [f.id, f]));
    for (const [id, entry] of markers.current) {
      if (!wanted.has(id)) { entry.marker.remove(); markers.current.delete(id); }
    }
    // Partners last, so they draw above public listings.
    for (const f of [...facilities].sort((a, b) => Number(isPartner(a)) - Number(isPartner(b)))) {
      if (markers.current.has(f.id)) continue;
      const el = markerElement(f, id => select.current(id));
      const marker = new Marker({ element: el, anchor: 'bottom' }).setLngLat([f.lon, f.lat]).addTo(m);
      markers.current.set(f.id, { marker, el, f });
    }
  }, [facilities, ready]);

  // Selection: raise the marker and bring it into view.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    for (const [id, { el }] of markers.current) el.classList.toggle('is-selected', id === selectedId);
    const chosen = selectedId ? markers.current.get(selectedId) : undefined;
    if (chosen) {
      const p = m.project([chosen.f.lon, chosen.f.lat]);
      const { clientWidth: w, clientHeight: h } = m.getContainer();
      if (p.x < 40 || p.y < 50 || p.x > w - 40 || p.y > h - 20) m.easeTo({ center: [chosen.f.lon, chosen.f.lat], duration: reducedMotion() ? 0 : 450 });
    }
  }, [selectedId, ready, facilities]);

  if (failed) {
    return <div className="fmap fmap--off" role="img" aria-label="Map unavailable"><p>The map cannot be shown on this device. Every place is in the list.</p></div>;
  }
  return (
    <div className="fmap">
      <div ref={box} className="fmap__canvas" role="region" aria-label={`Map of places near ${label}`} />
      {tileTrouble && <p className="fmap__note">Map background unavailable. Pins still work.</p>}
    </div>
  );
}
