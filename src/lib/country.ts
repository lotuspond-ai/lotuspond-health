// Country of residence: names in the reader's language, search, and a first guess for the sign-up form.
import { COUNTRY_CODES, countryName } from '../../shared/regions';

export interface CountryOption {
  code: string;
  name: string;
  /** Lower-case, accent-free text matched by search: the name, the code and common alternative names. */
  search: string;
}

/** Other names people type, mostly English. */
const ALIASES: Record<string, string> = {
  GB: 'uk united kingdom great britain britain england scotland wales northern ireland',
  US: 'usa united states america',
  AE: 'uae emirates dubai abu dhabi',
  NL: 'holland',
  CZ: 'czech republic czechia',
  KR: 'korea south korea',
  KP: 'north korea',
  CI: 'ivory coast',
  MM: 'burma',
  SZ: 'swaziland',
  MK: 'macedonia',
  TR: 'turkey turkiye',
  CV: 'cape verde',
  TL: 'east timor',
  VA: 'vatican holy see',
  RU: 'russia',
  IN: 'bharat',
  DE: 'deutschland',
  ES: 'espana',
  CH: 'schweiz suisse svizzera',
};

export const normalize = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

let cache: { locale: string; list: CountryOption[] } | null = null;

/** Every country, sorted by name in the reader's language. */
export function countryOptions(locale = typeof navigator !== 'undefined' ? navigator.language : 'en'): CountryOption[] {
  if (cache?.locale === locale) return cache.list;
  const list = COUNTRY_CODES.map(code => {
    const name = countryName(code, locale);
    const english = locale.startsWith('en') ? '' : countryName(code, 'en');
    return { code, name, search: normalize(`${name} ${english} ${code} ${ALIASES[code] ?? ''}`) };
  }).sort((a, b) => a.name.localeCompare(b.name, locale));
  cache = { locale, list };
  return list;
}

/** Options matching typed text: names that start with it first, then any word that does, then anything containing it. */
export function filterCountries(options: CountryOption[], query: string): CountryOption[] {
  const q = normalize(query);
  if (!q) return options;
  const starts: CountryOption[] = [], words: CountryOption[] = [], contains: CountryOption[] = [];
  for (const o of options) {
    const name = normalize(o.name);
    if (name.startsWith(q) || o.code.toLowerCase() === q) starts.push(o);
    else if (o.search.split(/[\s,()-]+/).some(w => w.startsWith(q))) words.push(o);
    else if (o.search.includes(q)) contains.push(o);
  }
  return [...starts, ...words, ...contains];
}

/** Main time zones by country (IANA names, including common old aliases). */
const ZONES: Record<string, string> = {
  IN: 'Asia/Kolkata Asia/Calcutta',
  GB: 'Europe/London', IE: 'Europe/Dublin', PT: 'Europe/Lisbon Atlantic/Madeira Atlantic/Azores', ES: 'Europe/Madrid Atlantic/Canary Africa/Ceuta',
  FR: 'Europe/Paris', BE: 'Europe/Brussels', NL: 'Europe/Amsterdam', LU: 'Europe/Luxembourg', DE: 'Europe/Berlin Europe/Busingen', CH: 'Europe/Zurich',
  AT: 'Europe/Vienna', IT: 'Europe/Rome', MT: 'Europe/Malta', CZ: 'Europe/Prague', SK: 'Europe/Bratislava', PL: 'Europe/Warsaw', HU: 'Europe/Budapest',
  SI: 'Europe/Ljubljana', HR: 'Europe/Zagreb', RS: 'Europe/Belgrade', BA: 'Europe/Sarajevo', ME: 'Europe/Podgorica', MK: 'Europe/Skopje', AL: 'Europe/Tirane',
  GR: 'Europe/Athens', BG: 'Europe/Sofia', RO: 'Europe/Bucharest', MD: 'Europe/Chisinau', UA: 'Europe/Kyiv Europe/Kiev', BY: 'Europe/Minsk',
  LT: 'Europe/Vilnius', LV: 'Europe/Riga', EE: 'Europe/Tallinn', FI: 'Europe/Helsinki', SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen',
  IS: 'Atlantic/Reykjavik', CY: 'Asia/Nicosia Europe/Nicosia', TR: 'Europe/Istanbul', MC: 'Europe/Monaco', AD: 'Europe/Andorra', LI: 'Europe/Vaduz',
  SM: 'Europe/San_Marino', VA: 'Europe/Vatican', GI: 'Europe/Gibraltar', IM: 'Europe/Isle_of_Man', JE: 'Europe/Jersey', GG: 'Europe/Guernsey',
  RU: 'Europe/Moscow Asia/Yekaterinburg Asia/Novosibirsk Asia/Vladivostok', GE: 'Asia/Tbilisi', AM: 'Asia/Yerevan', AZ: 'Asia/Baku',
  US: 'America/New_York America/Chicago America/Denver America/Los_Angeles America/Phoenix America/Anchorage Pacific/Honolulu America/Detroit America/Boise America/Indiana/Indianapolis America/Kentucky/Louisville',
  CA: 'America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Halifax America/St_Johns America/Regina America/Montreal',
  MX: 'America/Mexico_City America/Monterrey America/Tijuana America/Cancun America/Merida America/Chihuahua America/Hermosillo',
  GT: 'America/Guatemala', SV: 'America/El_Salvador', HN: 'America/Tegucigalpa', NI: 'America/Managua', CR: 'America/Costa_Rica', PA: 'America/Panama',
  CU: 'America/Havana', DO: 'America/Santo_Domingo', PR: 'America/Puerto_Rico', JM: 'America/Jamaica', TT: 'America/Port_of_Spain', BB: 'America/Barbados',
  BS: 'America/Nassau', HT: 'America/Port-au-Prince', CO: 'America/Bogota', VE: 'America/Caracas', EC: 'America/Guayaquil', PE: 'America/Lima',
  BO: 'America/La_Paz', CL: 'America/Santiago', AR: 'America/Argentina/Buenos_Aires America/Buenos_Aires America/Argentina/Cordoba', UY: 'America/Montevideo',
  PY: 'America/Asuncion', BR: 'America/Sao_Paulo America/Manaus America/Fortaleza America/Recife America/Bahia America/Belem', GY: 'America/Guyana',
  SR: 'America/Paramaribo', AE: 'Asia/Dubai', SA: 'Asia/Riyadh', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', KW: 'Asia/Kuwait', OM: 'Asia/Muscat',
  YE: 'Asia/Aden', JO: 'Asia/Amman', LB: 'Asia/Beirut', SY: 'Asia/Damascus', IL: 'Asia/Jerusalem Asia/Tel_Aviv', PS: 'Asia/Gaza Asia/Hebron',
  IQ: 'Asia/Baghdad', IR: 'Asia/Tehran', AF: 'Asia/Kabul', PK: 'Asia/Karachi', BD: 'Asia/Dhaka', NP: 'Asia/Kathmandu Asia/Katmandu', BT: 'Asia/Thimphu',
  LK: 'Asia/Colombo', MV: 'Indian/Maldives', MM: 'Asia/Yangon Asia/Rangoon', TH: 'Asia/Bangkok', LA: 'Asia/Vientiane', KH: 'Asia/Phnom_Penh',
  VN: 'Asia/Ho_Chi_Minh Asia/Saigon', MY: 'Asia/Kuala_Lumpur Asia/Kuching', SG: 'Asia/Singapore', ID: 'Asia/Jakarta Asia/Makassar Asia/Jayapura',
  PH: 'Asia/Manila', BN: 'Asia/Brunei', CN: 'Asia/Shanghai Asia/Urumqi', HK: 'Asia/Hong_Kong', MO: 'Asia/Macau', TW: 'Asia/Taipei', KR: 'Asia/Seoul',
  KP: 'Asia/Pyongyang', JP: 'Asia/Tokyo', MN: 'Asia/Ulaanbaatar', KZ: 'Asia/Almaty Asia/Qyzylorda', UZ: 'Asia/Tashkent', KG: 'Asia/Bishkek',
  TJ: 'Asia/Dushanbe', TM: 'Asia/Ashgabat', AU: 'Australia/Sydney Australia/Melbourne Australia/Brisbane Australia/Perth Australia/Adelaide Australia/Hobart Australia/Darwin',
  NZ: 'Pacific/Auckland', FJ: 'Pacific/Fiji', PG: 'Pacific/Port_Moresby', GU: 'Pacific/Guam', EG: 'Africa/Cairo', LY: 'Africa/Tripoli', TN: 'Africa/Tunis',
  DZ: 'Africa/Algiers', MA: 'Africa/Casablanca', NG: 'Africa/Lagos', GH: 'Africa/Accra', CI: 'Africa/Abidjan', SN: 'Africa/Dakar', KE: 'Africa/Nairobi',
  ET: 'Africa/Addis_Ababa', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala', RW: 'Africa/Kigali', SD: 'Africa/Khartoum', CD: 'Africa/Kinshasa Africa/Lubumbashi',
  AO: 'Africa/Luanda', ZA: 'Africa/Johannesburg', ZW: 'Africa/Harare', ZM: 'Africa/Lusaka', MZ: 'Africa/Maputo', NA: 'Africa/Windhoek', BW: 'Africa/Gaborone',
  MU: 'Indian/Mauritius', CM: 'Africa/Douala', MG: 'Indian/Antananarivo',
};

let zoneIndex: Map<string, string> | null = null;
function countryForZone(zone: string): string | null {
  zoneIndex ??= new Map(Object.entries(ZONES).flatMap(([code, zones]) => zones.split(' ').map(z => [z, code] as [string, string])));
  return zoneIndex.get(zone) ?? null;
}

/**
 * A first guess at where the person lives, from the browser's language region and time zone. "en-US" is the
 * default language of many devices worldwide, so a time zone elsewhere wins over it. The person always confirms.
 */
export function guessCountry(): string | null {
  let zone: string | null = null;
  try { zone = countryForZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''); } catch { /* no Intl time zone */ }
  let region: string | null = null;
  try {
    for (const lang of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const r = new Intl.Locale(lang).region;
      if (r && COUNTRY_CODES.includes(r)) { region = r; break; }
    }
  } catch { /* unusual language tag */ }
  if (zone && (!region || region === 'US')) return zone;
  return region ?? zone;
}
