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
- **App lock.** Optional: Your data → *Require Face ID* (Touch ID, fingerprint or face unlock on other phones), with the device passcode as fallback. See [App lock](#app-lock).
- **Storage in app files.** Results and original scan files are saved as files in the app's private Library folder rather than in the WebView's IndexedDB, which the OS may clear when the phone runs low on space. See [Storage](#storage).
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
| `src/native/` | The native bridge: platform detection, status bar, back button, launch screen, haptics, backup export, file storage |
| `src/lib/storage/` | Storage backends: `idb.ts` (browser) and `files.ts` (apps; tested in `tools/test-parsers.mjs` against an in-memory file system) |
| `src/components/Sheet.tsx` | The draggable bottom sheet |
| `src/lib/applock.ts`, `src/native/lock.ts`, `src/components/AppLock.tsx` | App lock: the state machine (tested in Node), its binding to the biometric and privacy-screen plugins, the lock screen and setting |
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
   4. The privacy manifest (`ios/App/App/PrivacyInfo.xcprivacy`) declares no tracking and no collected data. It lists one required-reason API: file timestamps, reason C617.1, because the Filesystem plugin reads file dates inside the app's container. Check it again when adding a plugin or native code; Xcode's *Generate Privacy Report* (on an archive) shows the combined report.
4. **Store forms.** Neither app collects or shares data:
   - App Store *App Privacy*: "Data Not Collected".
   - Play *Data safety*: no data collected or shared.
   - Both stores have health-app policies. Fill in Play's health apps declaration, and keep the "explains results, does not diagnose" wording in listings.

## Storage

In the browser, data stays in IndexedDB. In the apps, `src/native/storage.ts` switches the store to app files under `Library/lotuspond/` (Capacitor `Directory.Library`: the Library folder on iOS, the app's files folder on Android):

| File | Holds |
| --- | --- |
| `data-0.json`, `data-1.json` | Results and scan details. Saves alternate between the two files with a rising sequence number, and loading takes the newest one that reads cleanly, so a crash mid-save loses at most that save. |
| `scans/<id>.<ext>` | Original scan files. They are written in chunks to a `.part` file and renamed when complete; leftover `.part` files are deleted on the next launch. They are read back through the WebView's local file server, not as base64 over the bridge. |

Other safeguards:

- **Migration.** On the first launch after updating, data in IndexedDB is copied into these files and then removed from IndexedDB. A scan file that fails to copy stays there and is still found.
- **Unreadable data.** If the folder holding saved data can't be read, the app shows a warning and saves nothing for that session instead of writing over it.
- **Backgrounding.** A pending save is written at once when the app goes to the background.
- **Backups.** iOS device backups include the Library folder. Android's backup rules keep the files folder out of cloud backup.

## App lock

Turned on from **Your data → App lock**, in the apps only. Turning it on or off asks for Face ID (or Touch ID / fingerprint / face unlock) first.

- **When it asks.** At every launch, and again after the app has been in the background for longer than the chosen delay: as soon as you leave, 1 minute (the default) or 5 minutes.
- **Fallback.** If Face ID or the finger isn't recognised, the device passcode or screen lock works too (`allowDeviceCredential`), so nobody is locked out of their own results.
- **Before unlocking.** Saved results aren't loaded into memory until the app is unlocked (`holdHydration` in `src/lib/store.ts`).
- **App switcher.** While the lock is on, `@capacitor/privacy-screen` shows the launch screen instead of the app's content. On Android this also sets `FLAG_SECURE`, which blocks screenshots of the app.
- **Android's prompt.** The fingerprint prompt runs in its own activity, so Android pauses and resumes the app around it. Those events are ignored, so unlocking doesn't trigger another lock.
- **Passcode removed.** If the phone no longer has Face ID, a fingerprint or a passcode, the lock can't work, so it turns itself off and says so on Your data.
- **Damaged settings.** If the settings file (`Library/lotuspond/settings.json`) exists but can't be read, the lock stays on.
- **What it protects.** It stops someone holding the unlocked phone from opening LotusPond. It doesn't add encryption: saved files are protected by the OS's own file encryption, as before.
- **Plugin.** Biometrics come from `@aparajita/capacitor-biometric-auth` (MIT). `NSFaceIDUsageDescription` in `Info.plist` explains Face ID to the user.

## Not done yet

- **Device testing.** The apps were built and checked in CI and in a phone-sized browser; they have not been run on physical devices yet.
- **App lock on devices.** The lock logic is covered by tests in Node. Face ID, Touch ID and Android fingerprint prompts, the passcode fallback, and the app switcher cover still need checking on real phones.
- **Storage on devices.** The file storage above is covered by tests in Node against an in-memory file system. Migration from IndexedDB, large DICOM files and backgrounding still need checking on real iPhones and Android phones.
- **Later features:**
  - "Open in LotusPond" from Files, Mail and other apps (document types and intent filters)
  - 3D performance tuning on older phones
