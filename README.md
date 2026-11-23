# SIM South Florida content calendar

The complete deployable app for the `sim-cal` Vercel project (sim-cal.vercel.app). Vercel builds
this repo directly: static files at the root, the API in `api/calendar.js`.

| Path | What it is |
|------|------------|
| `index.html`, `assets/index-sim-v2.js` | The prebuilt React app (from the original Vite build), patched below. |
| `assets/index-sim-brand.css` | SIM brand theme: SIM Blue `#005085`, SIM Red `#C0312C` (accents only), Light Gray `#C1C6C8`, Dark Gray `#54585A`; Roboto Slab headlines, Open Sans body. |
| `sim-south-florida-logo.png` | Official SIM South Florida chapter logo, shown in the header. |
| `api/calendar.js` | Bundled server (posts, comments, reviews, uploads). Stores data in Vercel Blob. |
| `biscayne.jpg`, `Inter.woff2`, `favicon.svg` | Static assets. |

## Changes from the original build

- **Open editing while testing.** Everyone who opens the calendar can add posts, comment, approve
  and reject. No sign-in. To require the editor access code again, set `SIM_REQUIRE_EDIT_CODE=1`
  in the Vercel project's environment variables and redeploy.
- **Add a post on empty days.** The Selected day panel shows an "Add a post for this day" button.
- **Text-only posts show on the calendar.** Previously only posts with attached media appeared.
- **Reject.** "Request changes" is labeled "Reject"; a reason is required and is saved as a comment.
  A rejected post shows "Changes requested" and can be edited and resubmitted.

Review flow: Draft → Submit for review → Approve, or Reject → edit → resubmit.

## Environment variables (set in Vercel, not in this repo)

- Blob storage token (from the connected Vercel Blob store)
- `SIM_VIEW_KEY`, `SIM_EDIT_KEY`: access codes
- `SIM_VIEW_WITHOUT_CODE=1`: anyone with the link can view
- `SIM_REQUIRE_EDIT_CODE=1`: optional, turns the editor code back on
