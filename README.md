# SIM South Florida content calendar: brand theme

SIM-branded theme files for the `sim-cal` Vercel project (sim-cal.vercel.app).

The deployed app is a prebuilt Vite/React bundle. All of its colors and fonts live in the
stylesheet (the JS bundle has no color literals), so the rebrand only touches these files:

| File | Change |
|------|--------|
| `public/assets/index-sim-brand.css` | Replaces `index-Qt2I2cLX.css`. Teal/mint palette swapped for SIM Blue `#005085`, SIM Red `#C0312C` (accents only), Light Gray `#C1C6C8`, Dark Gray `#54585A`. Roboto Slab headlines, Open Sans body. Header shows the official chapter logo. |
| `public/index.html` | Loads Roboto Slab + Open Sans from Google Fonts, points at the new stylesheet, adds `theme-color`. |
| `public/favicon.svg` | Calendar icon recolored to SIM Blue with a red rule. |
| `public/sim-south-florida-logo.png` | Official SIM South Florida chapter logo (blue), 160px wide. |

Unchanged deployment files (`assets/index-DeIeQTIm.js`, `api/calendar.js`, `biscayne.jpg`,
`Inter.woff2`, `package.json`, `vercel.json`) are reused from the existing deployment by SHA.

Status colors: draft = gray, in review = amber, changes requested = SIM Red, approved = SIM Blue.
