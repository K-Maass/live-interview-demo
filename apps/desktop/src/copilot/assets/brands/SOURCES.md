# Brand marks: provenance

These files identify whose account a Settings → Calendars row reads. They are stored exactly as downloaded (byte for
byte, only renamed), are never recoloured, redrawn or altered, and always sit next to the provider's name and our own
labelled "Connect…" button. Design notes: `docs/design/2026-10-18-calendar-connections.md` §9.

| File | Source | Downloaded | Terms | SHA-256 |
|---|---|---|---|---|
| `microsoft-logo.svg` | https://learn.microsoft.com/en-us/entra/identity-platform/media/howto-add-branding-in-apps/ms-symbollockup_mssymbol_19.svg | 2026-10-18 | "Sign in with Microsoft" branding guidelines: https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps ("use the Microsoft logo to convey that Microsoft manages these accounts"; "DON'T alter the Microsoft logo") | `929f48f88c8ca7f3f5d294be47ec4caf51acc28ac25340c19a903125d7ecd84a` |
| `google-g@1x.png` | https://developers.google.com/static/identity/images/signin-assets.zip → `Android + Web/PNG @1x/Light/Theme=Light, Show text=No, Shape=Square, Platform=Android+Web.png` (kit dated 2026-04-15) | 2026-10-18 | Sign in with Google branding guidelines: https://developers.google.com/identity/branding-guidelines | `33f5ab7c3d6b6af7c8cdd3e917e4475d9a2ffd407a7667a68747140b290bdeb8` |
| `google-g@2x.png` | same kit, `PNG @2x/…@2x.png` | 2026-10-18 | as above | `707f430da8d0de13091baa30729a49475cd84af6b1d849b2a76aeabe0c093397` |
| `google-g@3x.png` | same kit, `PNG @3x/…@3x.png` | 2026-10-18 | as above | `f59c30836a255f81bb2ebe201f1f73dbc5261dc63cf854adc068a65264a7ee5e` |

Kit archive SHA-256 at download: `ba884069e12093b06bcfd776915081254a7c95094b80d50be2c5dc6bac1c1da1`.

How they are shown (`apps/desktop/src/copilot/settings/CalendarConnections.tsx`, `.cc-tile` in `styles/public.css`):

- Microsoft: the SVG as an `<img>` at 16×16 CSS px, original colours, centred in a 32 px white tile.
- Google: the PNGs are not edited. The kit's square button frame is clipped by CSS (an 18 px window over the centre
  70 % of the image, the same area as the design's 56 px crop of the @2x file), so only the full-colour G shows,
  on white, in a 32 px white tile. `srcset` picks @1x/@2x/@3x.

Not in this repository, on purpose:

- The Outlook app icon (Microsoft product icons need a licence).
- The Google Calendar product icon (needs approval through Google's Partner Marketing Hub, a new external account).
- Any Apple artwork. The Mac row shows the installed Calendar app's icon, read from macOS at runtime by the native
  `app_icon` command (allow-listed to `com.apple.iCal`), with a lucide `CalendarDays` outline as the fallback.

Google Calendar is a trademark of Google LLC. Microsoft and Outlook are trademarks of the Microsoft group of companies.
