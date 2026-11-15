# LotusPond design system

The source of the LotusPond design system, shared by LotusPond Works and LotusPond Health. `project/` is a byte-identical copy of `design-system/project/` in the LotusPond Works repository (`lotuspond-ai/lotuspond`), where the system was adopted (ADR-0016 there) and from where it is published to Claude Design as the "LotusPond" design system.

- `project/README.md` is the brand book: the idea, colour, type, shape, product screens, illustration, motion and voice.
- `project/tokens.json` holds every colour in light and dark, the type scale, spacing, radii and shadows.
- `project/components/` holds one folder per component with its guidelines and a live preview.
- `project/assets/Illustrations/` holds the approved "one thread" pictures.

## How it reaches LotusPond Health

The public landing page (`index.html`) is drawn in the system. `src/site/home.css` carries the tokens on `.home`, under the system's own names, and `tools/test-site-design.ts` (part of `npm test`) fails when one of them drifts from `project/tokens.json` or when a text, control or tomato pair drops below its WCAG 2.2 contrast floor. The illustrations the page uses are copied into `src/site/illustrations/`, so they are served from the site's own origin as its content security policy requires.

The legal pages, the 404 page and the app still use their earlier look (`src/site/site.css`, `src/index.css`).

Change a value in the Works repository first, copy `project/` here, then update `home.css`.
