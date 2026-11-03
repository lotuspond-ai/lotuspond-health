# Mobile apps (iOS and Android)

The iOS and Android apps are the LotusPond web app running in a native shell ([Capacitor 8](https://capacitorjs.com)). The 3D model, the report and DICOM readers and the on-device storage are the same code as the website. Each app ships the built site inside it, so it works offline and makes no network requests.

## What the apps add

- **Phone layout.** This also applies in phone browsers, below 760px wide:
  - bottom tabs (Body, Markers, Add, Scans, Data)
  - the organ and overview panel as a sheet you drag over the 3D model; the camera re-centres on the part left visible
  - full-screen dialogs
  - result cards instead of tables
  - a sticky "Add results" bar while reviewing an upload
- **Camera.** Add → *Take a photo* opens the camera for a report or a scan film.
- **Touch.** Pinch to zoom and double-tap in the scan viewer. Tap a landmark in an open organ to read its note.
- **Your data.** A tab to export a backup file through the system share sheet (Files, Drive, AirDrop and so on), restore one, or delete everything.
- **Native shell:**
  - launch screen and icons
  - status bar icons that turn light over the dark scan viewer
  - light haptics when you pick an organ or a tab
  - Android back button that steps back in order: closes the top layer, returns to the body map, closes the open organ, then sends the app to the background
- **Privacy defaults:**
  - Fonts are bundled, so there are no third-party requests.
  - Android cloud backup of app data is off (`android:allowBackup="false"` plus `data_extraction_rules.xml`), so results never reach Google Drive unless the user exports a backup there themselves. Device-to-device transfer still works.
  - iOS device backups (iCloud or computer) include app data as usual, encrypted by the OS.
- **Orientation.** Phones stay in portrait. Tablets rotate and get the wider layouts.

The apps accept any file type in the picker, because phones grey out types they can't name (DICOM usually shows up as `application/octet-stream`). Every file is checked by its content anyway. Files named `image.jpg`, as iOS names every camera shot, are renamed `Photo 09h05m01s.jpg` so that a second photo isn't mistaken for a duplicate.

## Requirements

| For | You need |
| --- | --- |
| Both | Node 22+ and `npm install` |
| iOS | macOS with Xcode 26 or later. Dependencies come through Swift Package Manager; there is no CocoaPods step. |
| Android | Android Studio with SDK 36, and JDK 21 |

## Build and run

```bash
npm run android      # build the site, copy it into both projects, open Android Studio
npm run ios          # same, then open Xcode
```

Run from Android Studio or Xcode, or pick a device from the terminal:

```bash
npx cap run android
```

```bash
npx cap run ios
```

After changing web code, run `npm run build:mobile` (site build plus `cap sync`) before running again. To reload as you edit, serve the site on your network and point the app at it:

```bash
npm run dev -- --host
```

```bash
npx cap run android --live-reload --host <your-computer's-LAN-IP> --port 5173
```

Debug builds can be inspected with Chrome (`chrome://inspect`) for Android, or Safari's Develop menu for iOS.

## Layout

| Path | What it holds |
| --- | --- |
| `capacitor.config.ts` | App id `ai.lotuspond.health`, name, launch screen and system bar settings |
| `android/`, `ios/` | The Android Studio and Xcode projects. They are source; the copied site (`public/`) and generated config are git-ignored and written by `cap sync`. |
| `src/native/` | The native bridge: platform detection, status bar, back button, launch screen, haptics, backup export |
| `src/components/Sheet.tsx` | The draggable bottom sheet |
| `src/lib/useMedia.ts` | `COMPACT`, the phone-layout breakpoint shared with `src/index.css` |
| `assets/`, `tools/mobile-assets.mjs` | Icon and launch screen sources. `npm run mobile:assets` regenerates every size (needs Playwright with Chromium). Android's adaptive icon is a vector in `res/drawable/ic_launcher_foreground.xml`. |
| `.github/workflows/mobile.yml` | CI: unsigned Android debug APK and iOS simulator build when native files or dependencies change |

## Releasing

1. **Version.**
   - Android: `versionCode` and `versionName` in `android/app/build.gradle`.
   - iOS: *Marketing Version* and *Current Project Version* in Xcode.
2. **Android.**
   1. Create an upload keystore. `*.jks`, `*.keystore` and `keystore.properties` are git-ignored; keep the key out of the repository.
   2. Add a release `signingConfig`.
   3. Run `cd android && ./gradlew bundleRelease` and upload the `.aab` to Play Console.
3. **iOS.**
   1. Set the team under *Signing & Capabilities*.
   2. Choose *Product → Archive* and upload from the Organizer.
   3. `ITSAppUsesNonExemptEncryption` is already `false` (the app only uses OS encryption).
4. **Store forms.** Neither app collects or shares data:
   - App Store *App Privacy*: "Data Not Collected".
   - Play *Data safety*: no data collected or shared.
   - Both stores have health-app policies. Fill in Play's health apps declaration, and keep the "explains results, does not diagnose" wording in listings.

## Not done yet

- **Device testing.** The apps were built and checked in CI and in a phone-sized browser; they have not been run on physical devices yet.
- **Durable storage.** Data lives in the WebView's IndexedDB, and the app asks the OS to keep it (`navigator.storage.persist()`). Moving results and scan files to native storage (Capacitor Filesystem or SQLite) would protect them from WebView data clean-up under severe storage pressure. Until then, the backup export is the safety net.
- **iOS privacy manifest.** Add `PrivacyInfo.xcprivacy` for the app target before the first App Store submission.
- **Later features:**
  - app lock with Face ID or fingerprint
  - "Open in LotusPond" from Files, Mail and other apps (document types and intent filters)
  - 3D performance tuning on older phones
