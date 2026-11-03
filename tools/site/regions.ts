// HTML snippets about storage regions, laws and availability, rendered at build time from shared/regions.ts so the
// public pages always match the policy the app enforces at sign-up.
import { COUNTRY_CODES, REGIONS, countryName, countryPolicy, type CountryPolicy, type DataRegion } from '../../shared/regions.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const name = (code: string) => countryName(code, 'en');
/** Names that take "the" inside a sentence ("the United Kingdom"). Table cells use the bare name. */
const THE = new Set('AE BS CD CF CZ DO GB GM KM KY MH MV NL PH SB TC US VA VG VI'.split(' '));
const inSentence = (code: string) => (THE.has(code) ? `the ${name(code)}` : name(code));
const byName = (a: string, b: string) => a.localeCompare(b, 'en');

function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const policies: CountryPolicy[] = COUNTRY_CODES.map(c => countryPolicy(c));
const available = policies.filter(p => p.available);
const unavailable = policies.filter(p => !p.available).sort((a, b) => byName(name(a.code), name(b.code)));

/** Who each region holds, in plain words. Home countries are fixed; cross-border countries come from the policy. */
const HOME: Record<DataRegion, string> = {
  in: 'People living in India',
  eu: 'People in the European Union and the European Economic Area',
  us: 'People in the United States and its territories',
  global: 'People in every other country where LotusPond Health is available',
};

const ORDER: DataRegion[] = ['in', 'eu', 'us', 'global'];

/** Short label for the countries a region is built for, used in the laws table. */
const HOME_SHORT: Record<DataRegion, string> = {
  in: 'India',
  eu: 'The EU and the EEA',
  us: 'The United States and its territories',
  global: 'Other countries',
};

function crossBorderNames(region: DataRegion): string[] {
  if (region === 'global') return [];
  return available.filter(p => p.region === region && p.crossBorder).sort((a, b) => byName(name(a.code), name(b.code))).map(p => inSentence(p.code));
}

function globalExamples(): string[] {
  const picks = ['AU', 'BR', 'JP', 'SG', 'ZA'];
  return picks.filter(c => available.some(p => p.code === c && p.region === 'global')).map(name);
}

function whoText(region: DataRegion): string {
  const extra = crossBorderNames(region);
  if (region === 'global') {
    const count = available.filter(p => p.region === 'global').length;
    return `${HOME.global}: ${count} countries and territories, such as ${listInWords(globalExamples())}.`;
  }
  return extra.length ? `${HOME[region]}, plus ${listInWords(extra)}.` : `${HOME[region]}.`;
}

/** Laws that apply to the people stored in a region, as the sign-up policy lists them. */
function lawsFor(region: DataRegion): { who: string; laws: string[] }[] {
  const groups = new Map<string, { home: boolean; who: CountryPolicy[]; laws: string[] }>();
  for (const p of available.filter(x => x.region === region)) {
    const key = p.laws.join('|');
    const g = groups.get(key) ?? { home: false, who: [], laws: p.laws };
    g.who.push(p);
    g.home ||= !p.crossBorder;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => Number(b.home) - Number(a.home))
    .map(g => ({
      who: g.home ? HOME_SHORT[region] : listInWords(g.who.sort((a, b) => byName(name(a.code), name(b.code))).map(p => inSentence(p.code))).replace(/^t/, 'T'),
      laws: g.laws,
    }));
}

const REGION_ICON: Record<DataRegion, string> = {
  in: 'IN', eu: 'EU', us: 'US', global: 'INTL',
};

/** Landing page: one card per region. */
function regionCards(): string {
  return ORDER.map(id => `
        <li class="region">
          <span class="region__code" aria-hidden="true">${REGION_ICON[id]}</span>
          <h3>${esc(REGIONS[id].name)}</h3>
          <p class="region__where">Stored on ${esc(REGIONS[id].storage)}</p>
          <p class="region__who">${esc(whoText(id))}</p>
        </li>`).join('');
}

/** Short list of country names where sign-up is not offered yet. */
function unavailableNames(): string {
  return esc(listInWords(unavailable.map(p => inSentence(p.code))));
}

/** Trust page: each unavailable country with the reason shown at sign-up. */
function unavailableTable(): string {
  const rows = unavailable.map(p => `
          <tr><th scope="row">${esc(name(p.code))}</th><td>${esc(p.unavailableReason ?? '')}</td></tr>`).join('');
  return `<div class="table-wrap"><table class="table table--stack">
        <thead><tr><th scope="col">Country</th><th scope="col">Why sign-up is not offered yet</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table></div>`;
}

/** Privacy and Trust pages: where records are stored, for whom. */
function storageTable(): string {
  const rows = ORDER.map(id => {
    const extra = crossBorderNames(id);
    const notice = id === 'global' || extra.length
      ? `<br><span class="muted">${id === 'global' ? 'Records are stored outside the person’s country, so sign-up names the region and asks for agreement.' : `For ${esc(listInWords(extra))}, records are stored outside the country, so sign-up says where and asks for agreement.`}</span>`
      : '';
    return `
          <tr><th scope="row">${esc(REGIONS[id].name)}</th><td>${esc(REGIONS[id].storage.replace(/^./, c => c.toUpperCase()))}</td><td>${esc(whoText(id))}${notice}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table class="table table--stack">
        <thead><tr><th scope="col">Region</th><th scope="col">Where records are kept</th><th scope="col">Whose records</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table></div>`;
}

/** Trust page: laws by region. */
function lawsTable(): string {
  const rows = ORDER.flatMap(id => {
    const groups = id === 'global' ? [] : lawsFor(id);
    if (id === 'global') {
      const local = available.filter(p => p.region === 'global' && !p.laws.includes('Local data-protection law'))
        .sort((a, b) => byName(name(a.code), name(b.code)));
      const items = local.map(p => `<li><b>${esc(name(p.code))}</b> ${esc(p.laws.join('; '))}</li>`).join('');
      return [`
          <tr><th scope="row">${esc(REGIONS[id].name)}</th><td>The data-protection law of each country, for example:<ul class="laws">${items}</ul></td></tr>`];
    }
    const cells = groups.map(g => `${groups.length > 1 ? `<p><b>${esc(g.who)}</b></p>` : ''}<ul>${g.laws.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('');
    return [`
          <tr><th scope="row">${esc(REGIONS[id].name)}</th><td>${cells}</td></tr>`];
  }).join('');
  return `<div class="table-wrap"><table class="table table--laws table--stack">
        <thead><tr><th scope="col">Region</th><th scope="col">Main laws we follow</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table></div>`;
}

const BLOCKS: Record<string, () => string> = {
  'region-cards': regionCards,
  'unavailable-names': unavailableNames,
  'unavailable-table': unavailableTable,
  'storage-table': storageTable,
  'laws-table': lawsTable,
  'available-count': () => String(available.length),
};

/** Replace `<!-- @regions name -->` markers with generated HTML. Unknown names fail the build. */
export function renderRegionBlocks(html: string, file: string): string {
  return html.replace(/<!--\s*@regions\s+([\w-]+)\s*-->/g, (_, key: string) => {
    const block = BLOCKS[key];
    if (!block) throw new Error(`${file}: unknown region block "${key}"`);
    return block();
  });
}
