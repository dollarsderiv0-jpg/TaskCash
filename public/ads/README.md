# `public/ads` — advertisement creative

Drop a picture in here, run one command, and it appears in the sponsored gallery on
the home page and in **Advertisements** inside the app.

```bash
npm run seed:ads              # publish everything in this folder
npm run seed:ads --dry-run    # say what it would do, write nothing
npm run seed:ads --draft      # create them hidden, to review in /admin/ads first
npm run seed:ads --remove     # remove every advert whose picture lives here
```

## Why a folder and not a URL

The pictures are supplied by the operator, so they are served from this
application's own origin (`/ads/<file>`). That means no third-party host, no CDN
account, and nothing that can start charging or disappear. Migration
`0013_advertisements_on_public_site.sql` allows a site-local path; `0009` required
an absolute `https://` URL.

An absolute URL still works — pass it in `manifest.json` if a creative is hosted
elsewhere.

## Naming

| Allowed | Not allowed |
| --- | --- |
| `registration-form.png` | `registration form.png` (space) |
| `deposit-mpesa.webp` | `deposit#1.png` (`#`, `?`, quotes) |

Letters, numbers, dot, dash and underscore only. A name that needs escaping in a
URL is skipped with a warning rather than silently mangled.

## Titles

An advert needs a title and a filename is not one. `manifest.json` supplies the
real words:

```json
{
  "registration-form.png": {
    "title": "Register your company",
    "advertiser": "TaskCash Pro",
    "description": "Company registration and compliance services.",
    "category": "COMPANY_REGISTRATION",
    "linkUrl": "/register",
    "altText": "A company registration form",
    "sortOrder": 10
  }
}
```

`category` is one of `COMPANY_REGISTRATION`, `DEPOSITS`, `WITHDRAWALS`,
`PAYMENTS`, `OTHER`. Lower `sortOrder` shows first. `linkUrl` may be a site path
(`/register`) or an `https://` address; leave it out for a purely informative
picture.

Without a manifest entry the run derives a placeholder title from the filename
and prints a warning naming the file. That is a placeholder to be replaced in
**Admin → Advertisements**, not copy.

## What these pictures do not do

Looking at an advertisement pays nobody. There is no timer, no reward and no
claim button, because the rewarded activity is watching sponsored video in
**Watch & Earn**. The gallery says so on the page.

## Before they will show

Adverts live in the `advertisements` table, so migrations `0009` and `0013` have
to be applied to the database first. Until then the home page quietly renders no
gallery at all and `/dashboard/ads` says the section is being set up.
