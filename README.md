# Arterial Blood Supply of the Head and Neck

A drag-and-drop study game. The arterial tree starts empty; drag each of the 63 terms
from the word bank into its place, from the arch of the aorta out to the last branch of
the maxillary artery. When a branch is right, blood flows into it.

**Play it:** https://periclesrocha.com/arterybloodsupply.game/

## How it plays

- **Practice** tells you right away whether a term is in the right place. Wrong drops
  bounce back to the bank and count as mistakes.
- **Test** gives no feedback until you press **Check answers**, then scores you.
  Wrong placements are marked in amber, and you can send them back and try again.
- **Branches must be in the same order as the slides** (optional) makes the smallest
  branches order-sensitive. Off by default, so they can go in any order under the
  right artery.
- **Hint** highlights an empty box and selects the term that goes there.
- Select any filled box to see what that artery supplies and its path from the aorta.
- On a phone or tablet, tap a term and then tap a box.

Best times and settings are saved in the browser.

## Editing the content

Everything lives in `data.js`: one nested object per artery, with its `label`, optional
`supplies` and `note` text, and its `children` in slide order. Change a label or add a
branch and the tree lays itself out again. No build step.

## Files

- `index.html`, `styles.css`, `app.js`: the game (plain HTML, CSS and JavaScript)
- `data.js`: the tree and the terms
- `fonts/`: Atkinson Hyperlegible and Crimson Pro, self-hosted (SIL Open Font License,
  see `fonts/LICENSE.txt`)

## Publishing (one-time setup)

Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch:
**main**, folder **/ (root)**. GitHub republishes the site after every push to `main`;
watch the "pages build and deployment" run in the Actions tab.

To run it locally: `python3 -m http.server` in this folder, then open
http://localhost:8000.
