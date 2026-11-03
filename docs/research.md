# LotusPond Health: research notes and decisions

Working notes behind the product decisions for the global launch. The country table in `shared/regions.ts` encodes these. **This is product research, not legal advice; each market needs legal review before launch.**

## 1. Compliance by market

| Market | Main rules for a consumer health-record app | What the product does |
| --- | --- | --- |
| India | Digital Personal Data Protection Act 2023; DPDP Rules 2025, notified November 2025 and phased in over 18 months. Consent-manager provisions apply from about November 2026; most obligations from May 2027. Anyone under 18 is a child, and processing their data needs verifiable consent from a parent or guardian. Data fiduciaries must publish a grievance contact. | India cell (records stored in India). Own accounts are for adults; children are added by a parent as family profiles. Explicit consent is recorded with a version. A grievance officer contact is shown. Partner-lab booking starts here. |
| EU / EEA | GDPR: health data is a special category (Art. 9) and needs explicit consent (Art. 9(2)(a)). Breach notification to the authority within 72 hours. European Health Data Space Regulation (EU) 2025/327 entered into force in March 2025 and applies from 26 March 2027, with more parts from 2029. It defines "wellness applications". | EU cell. Explicit health-data consent at sign-up. Export, correction and deletion are built in. |
| United Kingdom, Switzerland | UK GDPR and DPA 2018; Swiss revFADP. Both recognise EU/EEA storage. | Stored in the EU cell; sign-up says so (cross-border). |
| United States | HIPAA does not cover a direct-to-consumer app unless it acts for a covered entity, which would need a BAA. FTC Health Breach Notification Rule (16 CFR 318): the 2024 amendments, effective 29 July 2024, cover health apps and treat unauthorised disclosure as a breach. State consumer-health laws: Washington My Health My Data Act needs opt-in consent to collect, separate consent to share, and a signed authorisation to sell, plus a standalone Consumer Health Data Privacy Policy. Nevada SB 370 is similar; California has CCPA/CPRA and CMIA. | US cell. Opt-in consent before any health data is collected. Nothing is shared or sold. A Consumer Health Data Privacy section is on the Privacy page. |
| Canada | PIPEDA plus provincial health laws (for example Ontario PHIPA); Quebec Law 25 requires an assessment before data leaves Quebec. | Stored in the US cell with cross-border notice. Move to a Canadian cell when demand justifies it. |
| UAE | Federal Law No. 2 of 2019: health data related to services in the UAE may not be stored or processed outside the UAE without an approved exception. Abu Dhabi and Dubai health authorities enforce in-country hosting. | Not available until a UAE cell exists. |
| Saudi Arabia | PDPL plus health-sector rules; sources disagree on the details, so plan for in-country hosting. | Not available until a Saudi cell exists. |
| China, Russia | PIPL security assessment for exports; Russia's Federal Law 242-FZ localisation. | Not available. |
| Everywhere else | Local law: for example Australia Privacy Act 1988, Brazil LGPD, Singapore PDPA, Japan APPI, South Africa POPIA. | International cell. Sign-up states where records are stored and asks the person to agree (cross-border consent). |

Rules applied everywhere, because they meet the strictest common bar:

- **Adults only for own accounts (18+).** Children's records live as family profiles under a parent or guardian.
- **Explicit, recorded, versioned consent.** Terms and Privacy, explicit consent to process health data, and (where storage is abroad) consent to store in the named region. Each is stored with the text version, time and country. Withdrawing consent means deleting the account; that is one action in the app.
- **No sharing or sale of health data.** No advertising trackers, and only the strictly necessary session cookie, so no cookie banner is needed.
- **Data rights in the product:** export (JSON), correct (edit), delete (profile or account), and see what consent was given.
- **Security:** Argon2id passwords, hashed session tokens, per-account isolation, encryption at rest for uploaded files, an audit log of account events, and HTTPS only.
- **Breach readiness:** the audit log and per-region storage make it possible to scope a breach quickly. The incident runbook must meet the 72-hour notice under GDPR and DPDP and the FTC HBNR timelines.

Sources:
- [DPDP Rules 2025 (PIB)](https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf)
- [DPDP Rules, effective dates](https://dpdpa.dcomply.in/rules/)
- [India Briefing on DPDP Rules](https://www.india-briefing.com/news/dpdp-rules-2025-india-data-protection-law-compliance-40769.html/)
- [EHDS published (Baker McKenzie)](https://healthcarelifesciences.bakermckenzie.com/2025/03/05/european-health-data-space-regulation-published-whats-next/)
- [EHDS timeline](https://www.epr.eu/eu-health-data-space-regulation-to-be-implemented-throughout-the-next-4-years/)
- [UAE cross-border health data (US-UAE Business Council)](https://usuaebusiness.org/events/department-of-health-abu-dhabi-clarifies-cross-border-health-data-laws/)
- [UAE and KSA data transfers (Clifford Chance)](https://www.cliffordchance.com/content/dam/microsites/talkingtech/PDFs/Clifford%20Chance%20-%20Doing%20Business%20in%20the%20Middle%20East%20-%20Data%20Transfers%20in%20UAE%20and%20KSA%20(2).pdf)
- [Washington MHMDA (Goodwin)](https://www.goodwinlaw.com/en/insights/publications/2024/03/alerts-technology-hltc-my-health-my-data-act-mhmda)
- [MHMDA consent (Hintze Law)](https://hintzelaw.com/blog/2023/4/18/wa-my-health-my-data-act-pt5-consent-requirements)
- [FTC HBNR final rule (Covington)](https://www.insideprivacy.com/health-privacy/ftc-issues-final-rule-to-expand-scope-of-the-health-breach-notification-rule/)
- [FTC HBNR (Venable)](https://www.venable.com/insights/publications/2024/07/final-changes-to-health-breach-notification)

## 2. Data residency architecture

Each region (`in`, `eu`, `us`, `global`) is a **cell**: its own PostgreSQL database and file store, deployed in that region.

- Sign-up chooses the cell from the country of residence.
- A small **directory** maps an HMAC of the email to the cell, so sign-in knows where to look without storing the email in plain text outside the cell.
- The session cookie carries the cell, so later requests go straight there.
- A single deployment can serve several cells, with one connection per cell. That is fine to start with, but strict localisation (the India cell in India) means running the API in each region too, behind regional hostnames. The code supports both: a deployment serves only the cells it is configured with.
- Non-personal data stays in the default database: partner labs, the facility cache and the directory.

## 3. Nearby labs and facilities

- **Partner labs:** our own table (name, address, coordinates, tests, home collection, hours, accreditation such as NABL in India, booking link), imported from JSON by an admin command. Shown first, with a booking action.
- **Everything else:** OpenStreetMap data via the Overpass API. Tags: `healthcare=laboratory`, `healthcare=hospital` / `amenity=hospital`, `amenity=clinic` / `healthcare=clinic`, and imaging via `healthcare:speciality~radiology`. Queries are made by our server (the person's location never goes to a third party from their browser), rounded to about 1 km, and cached for 7 days. Responses carry "© OpenStreetMap contributors" attribution.
- **Geocoding:** typing an area or postcode uses Nominatim (OpenStreetMap). The usage policy allows at most 1 request per second, needs an identifying User-Agent, and caching. For scale, run your own Nominatim or Photon, or switch to a commercial geocoder; the provider is configurable.
- **Map:** MapLibre GL JS. For production, serve a self-hosted Protomaps PMTiles basemap file from our own server, so there is no third-party tile dependency. A regional extract keeps it small, for example `pmtiles extract … --bbox=<India>`. In development, OpenStreetMap raster tiles can be used, subject to their usage policy.
- **Getting there:** each facility shows distance, phone, hours and website, plus one-tap directions through the device's maps app (a Google Maps universal URL, Apple Maps on iOS).
- The development container cannot reach Overpass or Nominatim (blocked by its network policy). Providers are tested with recorded responses; live data works wherever the server has internet access.

## 4. Body map performance

Rendering happens on the person's device, so hosting the files on our server makes downloads fast but cannot by itself remove lag. The plan:

1. **Pre-rendered body map as the default view.** The high-quality 3D scene is rendered once at build time, for each body (female and male), from several angles into small WebP images. A matching "ID map" image per angle records which organ is at each pixel. Hover, click, organ highlights and result pins then work on any device with no WebGL cost, and dragging switches between angles.
2. **Interactive 3D on request** ("Explore in 3D") for x-ray and cross-sections, with a cheaper default:
   - no screen-space ambient occlusion and no reflective floor;
   - standard instead of physical materials on low tiers;
   - device pixel ratio capped and adapted to measured frame rate;
   - landmark labels mounted only for the open organ.
3. **Download once, keep on the device.** A service worker caches the app shell, the pre-rendered images and the 3D model of the body on screen (each profile shows one of the two bodies, and only that body's files are fetched). Assets have content hashes and are served with `immutable` caching and Brotli/gzip compression; meshopt-compressed models compress further.
