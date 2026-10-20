# OtoReader on the web

The browser version of [OtoReader](https://github.com/otobong77-del/omnibus-tools), an ebook
reader in the style of ReadEra. It signs in to Google and reads the folder the phone app syncs
to (`OtoReader/library.json` and `OtoReader/Books/`), so shelves, collections, favourites and
reading positions are shared with the phone.

This repository holds only the page itself (HTML, CSS and JavaScript). No books and no personal
data are stored here; everything you see after signing in comes from your own Google Drive.

Plain HTML and JavaScript, no build step and no server. The only third-party code is
`fflate.min.js` (unzipping EPUBs, MIT licence) and Google's sign-in script.

| File | What it does |
| --- | --- |
| `index.html`, `style.css` | The page: library, reader, side panels, setup screen |
| `app.js` | Library (shelves, collections, search, sort, actions), reader (chapters, pages, positions, contents, display options), saving back to Drive |
| `drive.js` | Google sign-in (OAuth token client) and the Drive API calls |
| `epub.js` | EPUB and TXT parsing in the browser |
| `tts.js` | Reading aloud with the browser's voices |
| `reader.bundle.js` | The phone app's pagination script, bundled by `build.sh` |
| `config.js` | Optional: paste the Google client ID here to skip the setup screen |

## One-time Google setup

Google requires an OAuth client ID for any website that opens your Drive. The page shows the
steps on first load: create a project at console.cloud.google.com, enable the Google Drive API,
set up the OAuth consent screen (External, add your own email as a test user), create an OAuth
client ID of type Web application with the page's address as an authorized JavaScript origin, and
paste the client ID into the page. It is stored in that browser only.
