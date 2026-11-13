# Seam Video Editor

A video editor that runs in your browser, on a PC or a phone. Stitch together as many videos, photos and songs as you like, add transitions, and export up to 4K with no watermark. Your files never leave your device: decoding, rendering and encoding all happen locally with WebCodecs.

## Features

- Unlimited videos, photos and music tracks
- 19 transitions (crossfade, dip to black, flash, slide, push, wipe, diagonal, circle, blinds, zoom), per clip or all at once, with adjustable length
- Trim, split, duplicate, and drag to reorder (long-press on touch screens)
- Music track with volume, fade in and fade out
- Photo duration, plus an optional slow zoom or pan on any clip
- Fit, fit with blurred background, or fill the frame
- Aspect ratios 16:9, 9:16, 1:1, 4:5, 4:3 and 3:4
- Export at 720p, 1080p, 1440p or 4K, at 24, 25, 30 or 60 fps, as H.264 or HEVC MP4 with AAC audio
- Undo/redo and keyboard shortcuts: Space play/pause, S split, Delete, Ctrl+Z / Ctrl+Shift+Z, arrow keys step one frame
- Installable as an app with offline support

## Use it

Once GitHub Pages is on (see below), open `https://<your-username>.github.io/<repo-name>/`.

- **PC:** in Chrome or Edge, use the install icon in the address bar to get a desktop app. Exports save straight to a file you pick.
- **Android:** in Chrome, menu → *Add to Home screen*.
- **iPhone:** in Safari, Share → *Add to Home Screen*. After exporting, tap *Share / Save to Photos*.

Keep the screen on and the app open while a video exports.

## Turn on GitHub Pages (once)

Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**. Every push to `main` then builds and deploys the site through `.github/workflows/pages.yml`.

## Build locally

```bash
npm ci
npm run build
```

`dist/` is the installable website, served from any static host. `dist-artifact/` is the same app packaged as a claude.ai page.

## Browser support

Needs WebCodecs: current Chrome, Edge or Safari (iOS 17+). HEVC (the iPhone default) only decodes where the browser and hardware support it. If a clip is refused on a PC, try Edge, or set iPhone *Camera → Formats → Most Compatible*.

## Built with

[Mediabunny](https://mediabunny.dev) (MPL-2.0) for reading and writing media files, and its AAC encoder extension for browsers without a native AAC encoder.
