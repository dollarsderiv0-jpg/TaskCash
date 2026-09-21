# Company images

Pictures of the companies behind TaskCash Pro, shown on the landing page and in
the dashboard slideshow.

## The managed list is the database, not this folder

Add, rename, reorder, hide and delete pictures at **`/admin/company-images`**.
An uploaded file goes to the **Supabase Storage** bucket `company-images`
(created by migration 0016) and the row stores its public URL — so publishing a
picture does not need a code change or a deploy.

A pasted address is also accepted, either an `https://` URL or a site-local
`/path` into this folder.

## What this folder is for

Only pictures shipped **with** the app, referenced as `/companies/<file>`.

It currently holds the four that seed the section while migration 0016 is
unapplied, listed in `src/content/company-images.ts`. That list is a fallback with
a deliberately short life: the moment the `company_images` table has a row, the
database becomes the only source and these four stop being served from code —
which is what makes them editable in the admin instead of pinned in a file.

## House rules for files here

- **Lowercase file names, no spaces.** The name becomes part of a URL, and a space
  in a URL is a broken image on somebody's phone.
- **JPEG, PNG or WebP, ideally ≤ 250 KB each.** Uploads through the admin are
  capped at 2 MB; these are served straight from the app with no optimiser.
- **Logos: transparent PNG. Photographs: landscape.** The slideshow shows every
  picture whole (`object-contain`) rather than cropping it, so a tall portrait
  image is letterboxed between two bars while a landscape one fills the frame.
- **SVG is not accepted for uploads.** It is the one image format that can carry
  script, so the admin refuses it. Flatten an SVG to PNG first.
