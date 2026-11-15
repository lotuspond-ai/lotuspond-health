# The assistant on WhatsApp

People can talk to the LotusPond assistant ([assistant.md](assistant.md)) from WhatsApp:
- ask about results;
- tell it readings to add;
- send a photo or PDF of a lab report, which is saved to their files for review in the app.

It uses Meta's WhatsApp Cloud API.

| Code | What |
| --- | --- |
| `server/src/whatsapp/service.ts` | Linking, the number directory, incoming messages, reports |
| `server/src/whatsapp/routes.ts` | `/api/whatsapp` (the app) and `/hooks/whatsapp` (Meta's webhook) |
| `server/src/whatsapp/client.ts` | Sending replies, marking messages read, downloading media, checking signatures |
| `server/src/assistant/turn.ts` | One assistant turn, shared with the app's chat |
| `shared/whatsapp.ts` | Types, notice version, code lifetime |
| `src/components/WhatsAppSettings.tsx` | Link, change profile, unlink (Account) |

## Linking a number

1. **The assistant comes first.** WhatsApp messages are answered by the assistant, so it has to be on.
2. **The notice.** On Account, Connected agents and assistant, the person chooses **Link WhatsApp** and reads the notice:
   - messages pass through WhatsApp, which Meta runs;
   - answers include health information, readable by anyone who can open WhatsApp on that phone;
   - photos and PDFs are saved to their files;
   - STOP ends it.
3. **Agreeing.** Agreeing records a `whatsapp` consent with `WHATSAPP_NOTICE_VERSION`.
4. **The code.** The server makes a 6-character code that works for 15 minutes; a new code replaces the last.
   - The app shows **Open WhatsApp**, a `wa.me` link to LotusPond's number with "Link my LotusPond account: CODE" already written.
   - It also shows the number and the message, to type by hand.
5. **Sending it.** When that message arrives, the number that sent it is linked: only someone holding that phone could have sent it. No SMS provider is needed.
   - The code works once.
   - A number belongs to one account. Linking it elsewhere unlinks it here, and an account has one number.
6. **Confirmation.** The app checks every 3 seconds and shows the linked number, partly hidden ("+91 ••••• •3210").
7. **The profile.** WhatsApp works on the account holder's profile. With family profiles, the person can choose another one on Account. The assistant can still read the other profiles it may see.

## Messages

- **Answers.**
  - Text goes to the assistant with the same tools, consent and kinds of data as the app.
  - The context says it is WhatsApp: no body map (`show_on_body` is not offered), plain text, `*bold*`, short answers.
  - Replies are converted to WhatsApp formatting and split under WhatsApp's 4096-character limit.
  - Booking links are written out.
- **Conversations.**
  - One WhatsApp conversation carries on until it has 40 turns or has been quiet for a day.
  - It is stored like an app conversation, with `channel = 'whatsapp'`.
  - The app lists it as "WhatsApp · …" and shows it read-only; it carries on in WhatsApp.
- **Reports.**
  - A photo (JPEG, PNG, WebP) or PDF is downloaded from Meta and saved as a `report` document on the profile.
  - It also makes a bell notification ("LotusPond assistant (WhatsApp) added a file"), whose **Delete** removes the file.
  - The reply links to `/app?review=DOC&profile=ID`, which opens the upload review on that file: the device read, then the optional Claude read, as for any upload.
  - The results are linked to the saved file instead of a second copy.
  - **Check results** in the bell, and **Read results** in Files, do the same.
- **Commands.**
  - `STOP` (or `UNLINK`) unlinks the number and withdraws the consent.
  - `HELP` explains.
  - `NEW` starts a fresh conversation.
- **Unknown numbers.** They get one "not linked" reply a day.
- **Limits.**
  - Each account can send 60 messages an hour, as in the app.
  - Each number's messages are handled in order.
  - The same message delivered twice is handled once: the ids of handled messages are kept for 7 days.
- **When it stops answering.**
  - When the assistant is turned off, messages get a note to turn it on in the app.
  - When the WhatsApp consent is withdrawn, the link is removed.

## Data and privacy

- **The number.**
  - It is kept only in the account's cell, in `whatsapp_links`.
  - The default database holds an HMAC of it (`whatsapp_directory`, keyed with `DIRECTORY_SECRET`), so incoming messages find the right cell without the number being stored there. This is like the email directory.
  - Link codes are HMACs too (`whatsapp_link_codes`).
- **Removal.** Unlinking, `STOP`, or deleting the account removes the link and the directory entry. Deleting the profile WhatsApp works on also removes the link.
- **Audit.** Linking, unlinking and sending a report are audit events (`whatsapp_linked`, `whatsapp_unlinked`, `whatsapp_report`) in Recent activity.
- **Privacy policy.** The policy covers this in sections 2, 5 and 9, and `CONSENT_VERSION` was bumped.
- **Webhook security.** Deliveries are accepted only with a valid `X-Hub-Signature-256` (HMAC-SHA256 of the body with the app secret). The handler answers 200 at once and handles the messages afterwards, as Meta asks.
- **Regions.** Messages reach the deployment Meta posts to. An account in a region served by another deployment is not reached; one API for every region (the default) has no such gap.

## Setting it up

1. **Meta's side.**
   - In Meta for Developers, create an app with the WhatsApp product and a WhatsApp Business Account.
   - Add and verify the business phone number.
   - Create a system user with `whatsapp_business_messaging` and a permanent access token.
2. **The server.** Set these in `server/.env`. WhatsApp is on when all five are set and the assistant is on.

   | Variable | What |
   | --- | --- |
   | `WHATSAPP_PHONE_NUMBER_ID` | The phone number's id (WhatsApp Manager, API setup) |
   | `WHATSAPP_NUMBER` | The number people message, with country code, e.g. `919876543210` |
   | `WHATSAPP_ACCESS_TOKEN` | The system user's token |
   | `WHATSAPP_APP_SECRET` | The app secret (App settings, Basic) |
   | `WHATSAPP_VERIFY_TOKEN` | Any long random string, also entered in Meta's webhook settings |
   | `WHATSAPP_GRAPH_URL` | Optional; defaults to `https://graph.facebook.com/v23.0` |

3. **The webhook.** In the app's WhatsApp configuration, set the callback URL to `PUBLIC_URL/hooks/whatsapp` with the same verify token, and subscribe to the `messages` field.
4. **Check it.** The server logs `WhatsApp: on (+number)`.

LotusPond only replies to messages people send it, inside WhatsApp's 24-hour customer service window, so no message templates are needed. Messages LotusPond starts itself, such as reminders, would need approved templates.

## Tested

- **Server** (`server/test/whatsapp.test.ts`). A stand-in WhatsApp client records what would be sent, and the scripted stand-in Claude answers. The test covers:
  - webhook verification;
  - unsigned deliveries refused;
  - the code flow: wrong code, any wording, works once, needs the assistant on;
  - masking the number;
  - consents and audit events;
  - repeat deliveries handled once;
  - answers without the body map, in WhatsApp formatting;
  - the conversation carried on, read-only in the app;
  - a reading added, with its notification;
  - `NEW` and `HELP`;
  - a PDF and a photo saved, with the review link, and Delete from the bell;
  - other file types refused;
  - `STOP`, unlinking in the app, a number moving to another account;
  - the assistant turned off;
  - account deletion.
- **Browser.** Against a stand-in Graph API and a simulated phone posting signed webhooks:
  - linking from Account;
  - questions and a reading over WhatsApp;
  - a PDF sent, then opened from the reply's link into the review, with 26 results added and linked to the one saved file;
  - the WhatsApp conversation shown read-only in the app.

## Not done yet

- A live run against Meta: it needs the WhatsApp Business account, number and token above.
- Voice notes.
- Choosing a profile from WhatsApp itself.
- Messages LotusPond starts itself (reminders, results ready), which need approved templates.
