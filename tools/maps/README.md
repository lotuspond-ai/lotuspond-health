# Self-hosted map tiles (Protomaps PMTiles)

The **Find a lab** map is drawn with MapLibre GL JS. In production, serve the basemap as a single
[PMTiles](https://docs.protomaps.com/pmtiles/) file from our own server. The map then makes no requests to
third parties: the person's browser only talks to LotusPond.

The server decides which tiles the page uses (`GET /api/config`), in this order:

| Setting | Map background |
| --- | --- |
| `MAP_PMTILES_URL` | A Protomaps vector basemap from a `.pmtiles` file (recommended) |
| `MAP_STYLE_URL` | Any MapLibre style JSON, for example your own tile server |
| neither | OpenStreetMap's raster tiles from `tile.openstreetmap.org` (development only) |

## 1. Install the `pmtiles` tool

Download the single binary for your platform from
[go-pmtiles releases](https://github.com/protomaps/go-pmtiles/releases) and put it on your `PATH`.

## 2. Cut a regional extract

Protomaps publishes planet builds; see [docs.protomaps.com/basemaps/downloads](https://docs.protomaps.com/basemaps/downloads)
for the current file name. `pmtiles extract` reads only the byte ranges it needs, so you do not download the
whole planet.

```bash
# India (mainland, Andaman and Nicobar, Lakshadweep). The box also covers parts of neighbouring countries.
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles india.pmtiles --bbox=68.1,6.5,97.4,35.7

# A single city is handy for development, e.g. Bengaluru:
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles bengaluru.pmtiles --bbox=77.45,12.83,77.78,13.14

pmtiles show india.pmtiles        # zoom range, bounds and size
```

A country at full detail is large. `--maxzoom=13` or `14` shrinks the file a lot (each zoom level holds about
four times the tiles of the one before); MapLibre keeps showing the last level when people zoom further in.
Re-extract every few months to pick up new roads and buildings.

## 3. Fonts and sprites

The Protomaps style needs glyphs (label fonts) and sprites (icons). Copy them from
[protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets) next to the tiles:

```bash
git clone --depth 1 https://github.com/protomaps/basemaps-assets /tmp/basemaps-assets
mkdir -p /srv/lotuspond/maps/assets
cp -r /tmp/basemaps-assets/fonts /tmp/basemaps-assets/sprites /srv/lotuspond/maps/assets/
mv india.pmtiles /srv/lotuspond/maps/
```

## 4. Serve them from the LotusPond server

In `server/.env` (or the host's environment):

```bash
MAP_TILES_DIR=/srv/lotuspond/maps
MAP_PMTILES_URL=/api/map/files/india.pmtiles
MAP_ASSETS_URL=/api/map/files/assets
```

The API serves `MAP_TILES_DIR` at `/api/map/files/` with HTTP range requests (PMTiles reads small ranges of
the file) and a day of browser caching. Everything comes from our own origin, so the Content Security Policy
needs no extra hosts. With Docker, mount the directory as a volume, for example
`- /srv/lotuspond/maps:/srv/lotuspond/maps:ro` in `docker-compose.yml`.

Check it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -r 0-126 http://localhost:8787/api/map/files/india.pmtiles   # 206
curl -s http://localhost:8787/api/config                                                                  # "type":"pmtiles"
```

Then open **Find a lab**: streets and labels appear under the pins, and the browser's network panel shows
only same-origin requests.

### From object storage or a CDN instead

Upload the `.pmtiles` file and the `assets/` folder to a bucket that supports range requests and CORS
(allow `GET` and `HEAD`, the `Range` request header, and expose `Content-Range`, `Content-Length` and
`ETag`). Set `MAP_PMTILES_URL` and `MAP_ASSETS_URL` to those `https://` URLs. The page CSP picks up their
hosts automatically: `mapCspSources()` in `server/src/facilities/map.ts` adds them to `img-src` and
`connect-src`.

## Other options

- **`MAP_STYLE_URL`**: a MapLibre style from your own tile server (for example tileserver-gl). The CSP allows
  the style's host; serve its tiles, glyphs and sprites from that same host.
- **No setting**: OpenStreetMap's raster tiles. Fine while developing, but their
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) rules out heavy use, and each
  person's browser then requests tiles from OpenStreetMap's servers.

Whatever the source, the map shows "© OpenStreetMap contributors" (the data is under the ODbL), plus
Protomaps for its basemap.
