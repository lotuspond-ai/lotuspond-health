# Importing from Apple Health and Health Connect

In the iOS and Android apps, **Add → Import from Apple Health** (iOS) or **Import from Health Connect** (Android) reads measurements saved on the phone: readings from a blood pressure cuff, a smart scale, a glucose meter or sensor, or a watch. The readings go to the same review as an uploaded report, and nothing is saved until the person presses Add. The app only reads, and never writes to the phone's health store.

| Code | What |
| --- | --- |
| `src/native/health.ts` | The phone's health store, through [`@capgo/capacitor-health`](https://github.com/Cap-go/capacitor-health) (pinned at 8.11.13) |
| `src/lib/health-import.ts` | Readings → one value per day → results. Plain data, tested in `tools/test-parsers.mjs` |
| `src/components/HealthImport.tsx` | The import step in the upload dialog |
| `shared/catalog.ts` (`VITALS`) | The markers the readings become |

## What is read

| Health store type | Marker | LOINC | Typical range used |
| --- | --- | --- | --- |
| Blood pressure | Systolic blood pressure, Diastolic blood pressure | 8480-6, 8462-4 | 90–120, 60–80 mmHg |
| Blood glucose | Glucose (home meter) | 41653-7 | 70–180 mg/dL |
| Resting heart rate | Resting heart rate | 40443-4 | 60–100 bpm |
| Oxygen saturation | Oxygen saturation (SpO2) | 59408-5 | 95% or more |
| Respiratory rate | Respiratory rate | 9279-1 | 12–20 breaths/min |
| Body temperature | Body temperature | 8310-5 | 36.1–37.2 °C |
| Weight | Body weight | 29463-7 | none |
| Body fat | Body fat | 41982-0 | none |

Home glucose is its own marker rather than fasting or random glucose, because a meter or sensor reading has no fasting state attached. Its typical range is the usual sensor target range, 70–180 mg/dL. The vitals markers have their own group, *Vitals & body*. Their aliases are kept specific ("systolic blood pressure", not "weight" or "pulse"), so the patient details in a report header don't become results.

Steps, sleep, workouts, heart rate variability and heart rate during exercise are not read. They are fitness data, not records a clinician asks for, and reading them would ask for more permissions than the import needs.

## How readings become results

1. **Choose.** The person picks the types (all are on at first) and a period: the last 30 days, 3 months or year. After a first import, *Since the last import* is offered and chosen.
2. **Permission.** The phone shows its own permission sheet for those types, read only. On Android the app also asks for Health Connect's history permission, without which reads stop at 30 days.
3. **Read.** One calendar month at a time, at most 20,000 readings per type per month. A glucose sensor gives about 9,000 a month.
4. **One value per day.** Each day's readings are averaged in the phone's time zone:
   - blood pressure gives a systolic and a diastolic value;
   - SpO2 and body fat in HealthKit's fractions (0.97) become percentages;
   - °F and mmol/L are converted;
   - readings outside plausible bounds (SpO2 under 50%, systolic over 300 and so on) are dropped as unit or sensor errors;
   - values are rounded to whole numbers, or one decimal for temperature, weight and body fat.
5. **Not today.** Today's readings are left out, because the day's average isn't final yet. They come in with the next import.
6. **Only new days.** A day already imported from the same source, for the same marker, is skipped.
7. **Review.** The results go to the upload review with a note of what was found, for example "Blood pressure: 24 days, Weight: 12 days". Each result is stored with the source *Apple Health* or *Health Connect*, its typical range and its status. The person can edit or remove any row before adding.

When the active profile isn't the account holder's own, the import says that these are the readings on this phone and should be imported only if they are that person's.

If nothing is found, the message tells the person where to allow access: *Settings → Health → Data Access & Devices* on iOS (HealthKit never says whether reading was refused), or *Health Connect → App permissions* on Android. An *Open Health Connect* button appears there when Health Connect needs installing or updating.

## Agents and follow-ups

Imported values are ordinary results, so connected agents see them in `get_results`, the health summary and marker history, with the LOINC code and the source. The summary now suggests a blood pressure reading when the profile lists hypertension and the last one is older than 3 months.

## Native setup

- **iOS.**
  - The HealthKit capability is in `ios/App/App/App.entitlements`, with no clinical records and no background delivery. `CODE_SIGN_ENTITLEMENTS` points to it in both build configurations.
  - `NSHealthShareUsageDescription` is in `Info.plist`. There is no `NSHealthUpdateUsageDescription`, because the app never asks to write.
  - The App ID needs the HealthKit capability in the Apple Developer account before a signed build.
  - The privacy manifest already declares Health data.
- **Android.**
  - `minSdkVersion` is 26, which Health Connect requires.
  - `AndroidManifest.xml` declares the eight `READ_*` permissions and `READ_HEALTH_DATA_HISTORY`. It removes, with `tools:node="remove"`, the plugin's 39 other permissions (writes, steps, sleep, VO2 max and so on). The merged manifest of a debug build has exactly those nine.
  - `health_connect_privacy_policy_url` in `strings.xml` is the page Health Connect opens from its permission screen.
  - Google Play needs the health apps declaration in Play Console before release.
- **Store rules.**
  - The privacy policy (section 2) says what is read, that only daily values the person confirms are stored, and that the data is never used for advertising or sold.
  - The Android section says that use of Health Connect data follows Google Play's Health Connect policy, including Limited Use.
  - Apple's guideline 5.1.3 and the Health Connect policy both allow sharing with third parties only with the person's consent. Agent sharing is that consent (`agent_sharing` records). The legal review should confirm this.

## Trying it

- **In a browser.** The import only appears in the apps. In development (`npm run dev`), a stand-in store can be set before the app loads: `window.__lotuspondHealthStore = { source: 'apple_health', available: async () => ({ available: true }), authorize: async () => {}, read: async (type, start, end) => [...] }`. Production builds leave this out.
- **On a phone.** Add data in the Health app (iOS) or a Health Connect app (Android) first, or use the iOS simulator's Health app.

## Not done yet

- A run on real phones. The Android debug APK builds, and its merged manifest was checked; the iOS build and both permission sheets still need a device.
- Clinical records from Apple Health (FHIR lab results from US providers). They need the `health-records` entitlement and Apple's review.
- Background or automatic imports. Each import is started by the person.
- Height into the profile, and a profile weight that follows the latest import.
