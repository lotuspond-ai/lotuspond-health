# Reading reports

Most Indian lab results reach people as PDFs, phone photos or WhatsApp images. LotusPond reads all of them into results the person checks before saving. It reads on the device first, and a photo goes to Claude only if the person asks for that one file.

| Upload | How it is read | Where |
| --- | --- | --- |
| PDF with a text layer | Positioned text, rows and columns (`src/lib/parse/pdf.ts`, `pdf-text.ts`) | Device |
| Photo of a report (JPEG, PNG, WebP, HEIC where the browser decodes it) | Text recognition, then the same row parser (`ocr.ts`, `ocr-engine.ts`, `ocr-read.ts`) | Device |
| Scanned PDF (no text layer) | Each page rendered, then text recognition as for photos (up to 10 pages) | Device |
| Any of the last two, when the device read is poor | Claude, after the person agrees for that file (`server/src/extraction/`) | Anthropic, then the device |
| Photo that is not a report (X-ray, skin) | Kept as a scan, as before | Device |

## On the device

- **Engine.** [Tesseract](https://github.com/naptha/tesseract.js) runs in a Web Worker with its LSTM English model (`4.0.0_best_int`). The worker, the core (three WebAssembly builds; the browser picks the one it supports) and the language data are served by LotusPond itself at `/ocr/<tesseract.js version>/`. The Vite plugin `tools/ocr-assets.ts` copies them from `node_modules` into the build and serves them in development.
  - Nothing comes from a CDN, so the app's Content-Security-Policy stays `'self'`.
  - A first read downloads about 3.9 MB (the core and the English data, compressed). The browser caches them for a year, and the folder name changes with the version.
  - The iOS and Android apps include the files.
  - The server-less preview leaves them out (its host serves only text, scripts and images), so photos there are kept as scans.
- **From words to results.**
  - Each photo is turned upright from its EXIF orientation, then scaled so its long side is 1,400–2,400 pixels.
  - Every word is placed on its text line's baseline, so words with descenders don't split a row. The page is then straightened by the median tilt of its long baselines, because a 2° tilt drifts 35 pixels across a row.
  - The words then become the same positioned text items a PDF gives, and the PDF row parser takes over: marker matching, units and conversion, ranges, flags and the sample date.
- **OCR clean-up.** `fixOcrWord` fixes the usual slips: "HbAlc" becomes HbA1c, "ulU/mL" becomes µIU/mL, and O or l inside a number become 0 or 1.
- **Doubtful values.** OCR mostly fails by losing a decimal point ("415" for 41.5). A value more than 4 times outside its printed range, or a percentage over 100, is marked **Check** in the review.
- **Read quality.** A read is poor when it found fewer than 3 results or the mean word confidence is under 70%.
- **Measured.** `npm run test:ocr` reads five synthetic photographed reports in common Indian layouts (`tools/fixtures/report-photos/`, made by `make-report-photos.py`). The photos are tilted, blurred, unevenly lit and JPEG-compressed. Each value is checked against the truth in `report-photos.json`: today 23 of 24 values are right. The miss is a lost decimal point, and it is marked Check, never Clear.
- **Units.** A converted value is shown converted in the review: 7800 cells/cumm becomes 7.8 next to 10^3/µL. Editing the box therefore keeps the unit right.

## With Claude, when the person chooses it

- **When it's offered.** In the upload review, a file whose device read was poor, or whose values include any marked Check, gets an offer: "Read it with Claude…". The offer appears only when the server has Anthropic credentials (`/api/config` says `aiExtraction`), and never in the preview.
- **Consent, per file.** The person ticks a notice saying that this file goes to Anthropic, the company that makes Claude; that it may be processed outside their country under Anthropic's terms; that only this file is sent, only now; and that LotusPond keeps a copy only if they add the results. Then they press Read with Claude.
  - The request carries the notice version (`AI_EXTRACTION_NOTICE_VERSION` in `shared/types.ts`). An older version is refused, so every recorded consent names the text the person saw.
  - Before the file is sent, the server records an `ai_extraction` consent (with the profile) and a `report_read_by_ai` event. Both appear on Account.
- **The request** (`server/src/extraction/claude.ts`).
  - It goes to the Anthropic SDK with `claude-opus-5-5`, medium effort and structured output. The schema covers: whether it is a lab report, the sample date, and each row as printed (name, value, unit, range, flag).
  - The system prompt asks for a transcription only: no interpretation, conversion or patient details. It also says that instructions inside the image are data.
  - Server-side refusal fallbacks are on (`fallbacks: "default"`). A refusal becomes a clear error.
  - Photos are scaled under 5 MB before sending; PDFs can be up to 20 MB.
  - Each account can read 30 files per hour.
- **Nothing stored.** The endpoint stores neither the file nor the rows. The app parses Claude's rows with its own JSON parser, they replace the device read of that file in the review, and the person checks and adds them as usual.
- **Settings.**
  - The feature is on when `ANTHROPIC_API_KEY` (or another credential the SDK reads) is set.
  - `AI_EXTRACTION=off` switches it off; `AI_EXTRACTION_MODEL` changes the model.
  - The server logs `reading reports with Claude: on` at start-up.

## LOINC codes

Each catalogue marker that has a confident match carries its LOINC code (`shared/loinc.ts`): 93 of 95 markers today. HOMA-IR and Lp-PLA2 are left out. Every code passes LOINC's check digit (checked in `tools/test-parsers.mjs`).

- Agents get the code in `get_results`, the health summary and marker history.
- A CSV with a LOINC column, or structured lab results carrying codes, match the marker by code.

LOINC is © Regenstrief Institute, Inc., used under the [LOINC license](https://loinc.org/license).

## Not done yet

- Reading in languages other than English (Hindi, Tamil and others need their own Tesseract data).
- Handwritten values and prescription photos.
- A measured accuracy on real reports. That needs a set of consented, de-identified photos from the beta.
- A live test of the Claude read. The code is tested against the SDK with a stand-in API; the first real run needs an API key.
