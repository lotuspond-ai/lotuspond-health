# Mobile apps (iOS and Android)

The iOS and Android apps are the LotusPond app shell (`app.html`) running in a native shell ([Capacitor 8](https://capacitorjs.com)). They have the same accounts, family profiles, body map, readers and lab finder as the website. Records are kept on the LotusPond server, as on the web: the apps sign in to the same accounts and keep nothing on the phone except the sign-in token and the app lock setting.

## What the apps add

- **Phone layout.** This also applies in phone browsers, below 760px wide:
  - bottom tabs: Body, Results, Add, Labs and Files. Files has a switch between *Reports and files* and *Scans*. The profile menu (family members, profile details, account, sign out) stays at the top right.
  - the organ and overview panel as a sheet you drag over the body map. The 2D map and the 3D camera fit into the part of the stage the sheet leaves visible.
  - full-screen dialogs, and a sticky "Add results" bar while you review an upload
  - result and file tables shown as cards
- **Camera.** Add → *Take a photo* opens the camera for a report or a scan film.
- **Touch.** Pinch to zoom and double-tap in the scan viewer. Tap a landmark in an open organ to read its note.
- **Files without links.** In the apps an API link can't be opened directly, because every request needs the sign-in token. Original reports and the profile export are therefore fetched with the token and handed to the system share sheet (Files, Drive, AirDrop, a PDF viewer...). The buttons are *Open or save* on Files and *Export* on Profile.
- **Location.** *Use my location* in Find a lab asks for approximate location only (`coarseLocation`). The app rounds it to about 1 km before saving it as the home area, as on the web.
- **Native shell:**
  - launch screen and icons
  - status bar icons that turn light over the dark scan viewer and the lock screen
  - light haptics when you pick an organ or a tab
  - Android back button that steps back in order: closes the top layer, returns to the body map, closes the open organ, then sends the app to the background
- **App lock.** Optional: Account → *App lock* → *Require Face ID* (Touch ID, fingerprint or face unlock on other phones), with the device passcode as fallback. See [App lock](#app-lock).
- **Privacy defaults:**
  - Fonts are bundled, and the app makes no requests except to the LotusPond API and the map tiles on Find a lab.
  - The token is kept in the Keychain (iOS, this device only, readable only while the phone is unlocked) or in storage encrypted with an Android Keystore key. It is not included in backups, and Android cloud backup of app data is off (`android:allowBackup="false"` plus `data_extraction_rules.xml`).
- **Orientation.** Phones stay in portrait. Tablets rotate and get the wider layouts.

The apps accept any file type in the picker, because phones grey out types they can't name (DICOM usually shows up as `application/octet-stream`). Every file is checked by its content anyway. Files named `image.jpg`, as iOS names every camera shot, are renamed `Photo 09h05m01s.jpg` so that a second photo isn't mistaken for a duplicate.

## Sign-in and the server

The apps load the shell from `capacitor://localhost` (iOS) or `https://localhost` (Android). Every API call is therefore cross-site and carries no cookies, so the apps use the server's **token sessions** (README, *Mobile apps*):

- **Sign-in and sign-up** send `X-LotusPond-Client: app`. The server answers with a token instead of a cookie, and the app saves it with `@aparajita/capacitor-secure-storage`.
- **Every request** carries `Authorization: Bearer <token>`. If the server answers 401 (the session expired, or was signed out from another device), the app forgets the token and returns to the sign-in screen.
- **Regions.** Sign-up goes to the server for the region of the chosen country (`apiOrigins` from `GET /api/auth/config`). Sign-in follows a `wrong_region` answer to the host that holds the account and stays with it.
- **Code.** `src/api/appSession.ts` (token, origin, headers) and `src/api/http.ts` in app mode, which `src/api/index.ts` turns on when running natively. They are tested against the real API in `tools/test-app-client.ts` (`npm run test:app`), through a stand-in for the web view that preflights, enforces CORS and refuses cookies.

By default the apps call the public site (`SITE_URL`, `https://health.lotuspond.ai`). Set `VITE_API_ORIGIN` at build time to use another server.

## Requirements

| For | You need |
| --- | --- |
| Both | Node 22.12+ and `npm install` |
| iOS | macOS with Xcode 26 or later. Dependencies come through Swift Package Manager; there is no CocoaPods step. |
| Android | Android Studio with SDK 36, and JDK 21 |

## Build and run

```bash
npm run android      # build the app shell, copy it into both projects, open Android Studio
```

```bash
npm run ios          # same, then open Xcode
```

Run from Android Studio or Xcode, or pick a device from the terminal:

```bash
npx cap run android
```

```bash
npx cap run ios
```

After changing web code, run `npm run build:mobile` again (`tools/build-mobile.mjs` builds only the app shell into `dist-mobile/`, then `cap sync` copies it in). For layout work a phone-sized browser on `npm run dev` is quicker, since it shows the same phone layout.

### Against a server on your computer

Start the server so the phone can reach it:

```bash
HOST=0.0.0.0 npm run local
```

Then point the app at it. Either:

- **Use a test build with the server picker.** The debug APK from CI (the `lotuspond-health-debug-apk` artifact of the *Mobile apps* workflow) and any build made with `VITE_SERVER_PICKER=1 npm run build:mobile` show *Test build · server … Change* under the sign-in form and on the "can't be reached" screen. Enter the server's address there, for example `192.168.1.20:8787`. The app checks that a LotusPond server answers, signs out of the old one and restarts. *Back to …* returns to the build's own server.
- **Or build it in**, with no picker:

  ```bash
  VITE_API_ORIGIN=http://192.168.1.20:8787 npm run build:mobile
  ```

Use your computer's LAN address for a phone on the same Wi-Fi, `http://localhost:8787` for the iOS Simulator, or `http://10.0.2.2:8787` for the Android emulator. Plain http is allowed only for this: Android debug builds allow cleartext (`android/app/src/debug/AndroidManifest.xml`; release builds are https only), and iOS allows local network addresses (`NSAllowsLocalNetworking`).

Debug builds can be inspected with Chrome (`chrome://inspect`) for Android, or Safari's Develop menu for iOS.

## Layout

| Path | What it holds |
| --- | --- |
| `capacitor.config.ts` | App id `ai.lotuspond.health`, name, `webDir: 'dist-mobile'`, launch screen and system bar settings |
| `android/`, `ios/` | The Android Studio and Xcode projects. They are source; the copied shell (`public/`) and generated config are git-ignored and written by `cap sync`. |
| `src/native/` | The native bridge: status bar, back button, launch screen, haptics (`index.ts`), token storage (`tokens.ts`), share sheet (`share.ts`), location (`location.ts`), app lock (`lock.ts`) and app files (`files.ts`, for the lock setting) |
| `src/api/appSession.ts` | Token sessions for the apps (see above) |
| `src/styles/mobile.css` | Everything specific to phones and the app shells: safe areas, tab bar, sheet, cards, full-screen dialogs. It loads after the shared styles. |
| `src/components/Sheet.tsx` | The draggable bottom sheet |
| `src/lib/applock.ts`, `src/components/AppLock.tsx` | App lock: the state machine (tested in Node), the lock screen and the setting |
| `src/lib/useMedia.ts` | `COMPACT`, the phone-layout breakpoint shared with `src/styles/mobile.css` |
| `assets/`, `tools/mobile-assets.mjs` | Icon and launch screen sources. `npm run mobile:assets` regenerates every size (needs Playwright with Chromium). Android's adaptive icon is a vector in `res/drawable/ic_launcher_foreground.xml`. |
| `.github/workflows/mobile.yml` | CI: unsigned Android debug APK (installable on a phone, with the server picker) and iOS simulator build. It runs when native files, the Capacitor config or dependencies change, and on demand (*Actions → Mobile apps → Run workflow*) for a fresh APK after app changes |

Plugins: `@capacitor/app`, `filesystem`, `geolocation`, `haptics`, `privacy-screen`, `share`, `splash-screen`, plus `@aparajita/capacitor-biometric-auth` and `@aparajita/capacitor-secure-storage` (both MIT).

## Releasing

1. **Build the shell without the server picker.** Run `npm run build:mobile` with `VITE_SERVER_PICKER` unset. Only test builds have the picker, and CI's builds are test builds.
2. **Version.**
   - Android: `versionCode` and `versionName` in `android/app/build.gradle`.
   - iOS: *Marketing Version* and *Current Project Version* in Xcode.
3. **Android.**
   1. Create an upload keystore. `*.jks`, `*.keystore` and `keystore.properties` are git-ignored; keep the key out of the repository.
   2. Add a release `signingConfig`.
   3. Run `cd android && ./gradlew bundleRelease` and upload the `.aab` to Play Console.
4. **iOS.**
   1. Set the team under *Signing & Capabilities*.
   2. Choose *Product → Archive* and upload from the Organizer.
   3. `ITSAppUsesNonExemptEncryption` is already `false` (the app only uses HTTPS and OS encryption).
5. **Privacy manifest** (`ios/App/App/PrivacyInfo.xcprivacy`). It declares no tracking. It lists the data the account stores, all linked to the person and used only for the app's functionality:
   - email address and name
   - user ID
   - health data: results, scans, conditions, medications, allergies, height and weight
   - photos (report and scan photos)
   - other user content (uploaded reports and notes)
   - coarse location (the home area, about 1 km)
   - other data types (date of birth, sex assigned at birth, country)
   - other diagnostic data (account security events: app version and a hashed IP address)

   It also lists one required-reason API: file timestamps, reason C617.1, because the Filesystem plugin reads file dates inside the app's container. Check it again when the server starts storing something new, or when adding a plugin or native code. Xcode's *Generate Privacy Report* (on an archive) shows the combined report.
6. **Store forms.** Answer them from the same list:
   - App Store *App Privacy*: the data types above, linked to the user, not used for tracking, purpose App Functionality.
   - Play *Data safety*: the matching types (personal info, health and fitness, photos, files and docs, approximate location, app info and performance). Mark them collected, not shared, encrypted in transit, and deletable on request (Account → *Delete account*).
   - Both stores have health-app policies. Fill in Play's health apps declaration, and keep the "explains results, does not diagnose" wording in listings.
   - The App Store requires in-app account deletion. Account → *Delete account* does this.
7. **Age rating and content.** The body map shows real anatomy: the Visible Human skin, the breasts and the reproductive organs, in the default view and in the store screenshots. Answer the App Store age-rating questions (medical or treatment information; nudity) and Play's content rating questionnaire with that in mind, and check the screenshots against each store's rules.
8. **Licences.** Both bodies, and the body map images made from them, are CC BY-SA 4.0 (see `/credits/` on the website). The apps carry the attribution themselves (the credit line on the stage and Account → *Credits and licences*), because they ship the model files without the website. CC BY-SA 4.0 does not allow technical measures that restrict reuse, which app-store encryption may count as, so keep the model files downloadable without DRM from the credits page (`/models/anatomy-<body>.glb`).

## App lock

Turned on from **Account → App lock**, in the apps only. Turning it on or off asks for Face ID (or Touch ID / fingerprint / face unlock) first.

- **When it asks.** At every launch, and again after the app has been in the background for longer than the chosen delay: as soon as you leave, 1 minute (the default) or 5 minutes.
- **Fallback.** If Face ID or the finger isn't recognised, the device passcode or screen lock works too (`allowDeviceCredential`), so nobody is locked out of their own results.
- **Before unlocking.** The app doesn't contact the server or load any records until it is unlocked (`sessionReady` in `src/native/index.ts`).
- **App switcher.** While the lock is on, `@capacitor/privacy-screen` shows the launch screen instead of the app's content. On Android this also sets `FLAG_SECURE`, which blocks screenshots of the app.
- **Android's prompt.** The fingerprint prompt runs in its own activity, so Android pauses and resumes the app around it. Those events are ignored, so unlocking doesn't trigger another lock.
- **Passcode removed.** If the phone no longer has Face ID, a fingerprint or a passcode, the lock can't work, so it turns itself off and says so on Account.
- **Damaged settings.** If the settings file (`Library/lotuspond/settings.json`) exists but can't be read, the lock stays on.
- **What it protects.** It stops someone holding the unlocked phone from opening LotusPond on it. It only applies to that phone: signing in anywhere else still needs the password.

## Not done yet

- **Device testing.** The apps were built in CI and checked in a phone-sized browser and against the real API in Node. They have not been run on physical devices yet. Still to check there:
  - sign-in and the Keychain / Keystore token across restarts
  - the share sheet for reports and exports
  - the location prompt
  - Face ID, Touch ID and Android fingerprint prompts, the passcode fallback and the app switcher cover
- **Self-hosted map tiles.** With `MAP_PMTILES_URL` the apps fetch the `.pmtiles` file from the API host in byte ranges, across origins. The server's CORS answer allows `Range` and exposes `Content-Range` and `ETag` for this, but it hasn't been tried in the iOS and Android web views yet.
- **Later features:**
  - "Open in LotusPond" from Files, Mail and other apps (document types and intent filters)
  - 3D performance tuning on older phones (each body is about 1.2 million triangles; both bodies and both body map sets ship in every app)
