# xhyumiracle.com

Personal homepage (v10: the real sky). Static, zero-dependency: one HTML file, one stylesheet,
three scripts, six self-hosted font files (CJK subset is 5KB), one avatar, one CV PDF, and the
sky data: `data/stars.bin` (41,486 stars from HYG v4.4 to magnitude 8, 6 bytes each, CC BY-SA 4.0,
astronexus.com/projects/hyg) and `img/starmap-2k.{webp,jpg}` (NASA SVS Deep Star Maps 2020,
public domain, tone-mapped and softened; svs.gsfc.nasa.gov/4851). Both are rebuilt by
`tools/build-sky-data.py` and the notes in `design/research-sky.md`.

`js/starfield3d.js` draws the sky in WebGL (stereographic view of the winter evening sky from
40N, the four module asterisms are Orion, Taurus, Canis Major, Gemini); `js/starfield.js` is the
v9 canvas sky, loaded only where WebGL is unavailable.

Serve the `/` of this directory with any static file server.
`?shot=<section-id>` freezes a section fullscreen for screenshots.
