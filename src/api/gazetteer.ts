// A small offline list of places for the server-less preview, which cannot reach a geocoder.
// [label, ISO country, latitude, longitude]; city centres, rounded.
import type { GeoCandidate } from '../types';

const PLACES: [string, string, number, number][] = [
  ['Indiranagar, Bengaluru', 'IN', 12.9719, 77.6412], ['Koramangala, Bengaluru', 'IN', 12.9352, 77.6245], ['Bengaluru', 'IN', 12.9716, 77.5946],
  ['Mumbai', 'IN', 19.076, 72.8777], ['New Delhi', 'IN', 28.6139, 77.209], ['Chennai', 'IN', 13.0827, 80.2707], ['Hyderabad', 'IN', 17.385, 78.4867],
  ['Kolkata', 'IN', 22.5726, 88.3639], ['Pune', 'IN', 18.5204, 73.8567], ['Ahmedabad', 'IN', 23.0225, 72.5714], ['Jaipur', 'IN', 26.9124, 75.7873],
  ['Lucknow', 'IN', 26.8467, 80.9462], ['Kochi', 'IN', 9.9312, 76.2673], ['Chandigarh', 'IN', 30.7333, 76.7794], ['Indore', 'IN', 22.7196, 75.8577],
  ['Bhopal', 'IN', 23.2599, 77.4126], ['Coimbatore', 'IN', 11.0168, 76.9558], ['Nagpur', 'IN', 21.1458, 79.0882], ['Visakhapatnam', 'IN', 17.6868, 83.2185],
  ['Thiruvananthapuram', 'IN', 8.5241, 76.9366], ['Mysuru', 'IN', 12.2958, 76.6394], ['Guwahati', 'IN', 26.1445, 91.7362], ['Bhubaneswar', 'IN', 20.2961, 85.8245],
  ['Patna', 'IN', 25.5941, 85.1376], ['Surat', 'IN', 21.1702, 72.8311], ['Noida', 'IN', 28.5355, 77.391], ['Gurugram', 'IN', 28.4595, 77.0266],
  ['London', 'GB', 51.5074, -0.1278], ['Manchester', 'GB', 53.4808, -2.2426], ['Dublin', 'IE', 53.3498, -6.2603], ['Paris', 'FR', 48.8566, 2.3522],
  ['Berlin', 'DE', 52.52, 13.405], ['Amsterdam', 'NL', 52.3676, 4.9041], ['Madrid', 'ES', 40.4168, -3.7038], ['Rome', 'IT', 41.9028, 12.4964],
  ['New York', 'US', 40.7128, -74.006], ['San Francisco', 'US', 37.7749, -122.4194], ['Los Angeles', 'US', 34.0522, -118.2437], ['Chicago', 'US', 41.8781, -87.6298],
  ['Toronto', 'CA', 43.6532, -79.3832], ['Sydney', 'AU', -33.8688, 151.2093], ['Melbourne', 'AU', -37.8136, 144.9631], ['Singapore', 'SG', 1.3521, 103.8198],
  ['Nairobi', 'KE', -1.2921, 36.8219], ['Lagos', 'NG', 6.5244, 3.3792], ['São Paulo', 'BR', -23.5505, -46.6333], ['Mexico City', 'MX', 19.4326, -99.1332],
  ['Tokyo', 'JP', 35.6762, 139.6503], ['Johannesburg', 'ZA', -26.2041, 28.0473], ['Kathmandu', 'NP', 27.7172, 85.324], ['Colombo', 'LK', 6.9271, 79.8612],
  ['Dhaka', 'BD', 23.8103, 90.4125],
];

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Places whose name has a word starting with the query (or contains it), best matches first. */
export function searchOffline(q: string, limit = 5): GeoCandidate[] {
  const needle = fold(q.trim());
  if (needle.length < 2) return [];
  const scored = PLACES.map(([label, country, lat, lon]) => {
    const name = fold(label);
    const score = name.startsWith(needle) ? 0 : name.split(/[\s,]+/).some(w => w.startsWith(needle)) ? 1 : name.includes(needle) ? 2 : -1;
    return { score, c: { label, detail: null, lat, lon, country, postalCode: null } satisfies GeoCandidate };
  }).filter(x => x.score >= 0);
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map(x => x.c);
}
