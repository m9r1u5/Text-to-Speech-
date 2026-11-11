# Offline Reader
Offline text-to-speech reader with natural Piper voices. One repo, two ways to install:

- **iPhone / any phone (web app):** https://m9r1u5.github.io/Text-to-Speech-/ - open in Safari, Share, Add to Home Screen.
- **Android (APK):** latest file on the Releases page.

**Tabs:** *Text* (paste text) and *PDF* (choose a PDF, its text is extracted on the phone with a bundled copy of pdf.js and sent to the reader). Scanned PDFs that are only pictures have no text and cannot be read.

**Reading with the screen off (Android):** while reading, the app runs a background service with a notification, holds a CPU wake lock and buffers extra sentences. On Samsung phones also tap **Allow reading with the screen off** (Voice and speed card) and choose Allow so the battery saver does not stop the app.

Every push to `main` builds the APK, publishes a GitHub Release, and updates the web app on GitHub Pages.
Settings -> Pages -> Source must be set to **GitHub Actions**.
