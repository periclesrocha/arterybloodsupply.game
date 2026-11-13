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

Each player enters a nickname before playing. Score = completion time + 10 seconds per
mistake + 20 seconds per hint; lower is better. Runs that end with **Show answers** don't
count.

## Leaderboard

Finished runs go to a global leaderboard, one board per mode (Practice / Test) and branch
order (any order / slide order), ranked by each nickname's best score. Select a name to
see all of that player's runs. Nicknames are case-insensitive, so "Ana" and "ana" are the
same player, and every run is kept under it. There are no logins or email addresses.

Scores are stored in a free [Supabase](https://supabase.com) database (GitHub Pages can
only serve files, it can't save anything). Every run is also kept in the player's browser,
so the game works without the leaderboard: until it's connected, or if it can't be
reached, the Leaderboard shows the scores from that device, and runs that couldn't be sent
are sent the next time the game opens.

### Setting it up (about 5 minutes, once)

1. Go to [supabase.com](https://supabase.com), sign up (email or GitHub), and create a new
   project on the free plan (any name; pick the region closest to your players; save the
   database password somewhere, though the game doesn't need it).
2. When the project is ready, open **SQL Editor**, start a new query, paste everything in
   [`supabase/leaderboard.sql`](supabase/leaderboard.sql) and click **Run**. It creates the
   `scores` table, the `leaderboard` view and the access rules. It's safe to run again.
3. Copy two values from the project:
   - the **Project URL**, which looks like `https://abcdefghijklmnop.supabase.co`
   - the **publishable key**, which starts with `sb_publishable_` (an older project may
     show an "anon public" key starting with `eyJ` instead; that works too)

   Both are in the project's settings (look for **API Keys** and **Data API**), and the
   **Connect** button at the top of the dashboard shows them as well.
4. Put them in [`config.js`](config.js) (you can edit it right on GitHub) and commit.
   GitHub Pages republishes in about a minute, and the leaderboard is live.

The publishable key is meant to be public. The rules in `leaderboard.sql` only let it read
scores and add new ones: it can't change or delete a score, set the date or the score
itself, post a time under 30 seconds, or post for the same nickname twice within 15
seconds. Never put a secret key (`sb_secret_...`) or the `service_role` key in `config.js`.

**Good to know**

- Without logins, anyone can type someone else's nickname, and a determined person could
  post a fake score through the API. To remove one, open the `scores` table in Supabase's
  **Table Editor** and delete the row.
- Free Supabase projects pause after 7 days without activity (the data is kept, and you
  can resume the project from the dashboard). The workflow in
  `.github/workflows/keep-leaderboard-awake.yml` reads the leaderboard every 3 days to
  prevent that. GitHub turns off scheduled workflows in repositories with no commits for
  60 days; if that happens, re-enable it from the **Actions** tab.
- To change the penalties, change them in `app.js` and in `supabase/leaderboard.sql`
  (the file explains how to update an existing database).

Personal settings (nickname, mode, sound, sort order) are saved in the browser.

## Editing the content

Everything lives in `data.js`: one nested object per artery, with its `label`, optional
`supplies` and `note` text, and its `children` in slide order. Change a label or add a
branch and the tree lays itself out again. No build step.

## Files

- `index.html`, `styles.css`, `app.js`: the game (plain HTML, CSS and JavaScript)
- `data.js`: the tree and the terms
- `config.js`: the leaderboard connection (Supabase URL and publishable key)
- `supabase/leaderboard.sql`: the database setup for the leaderboard
- `fonts/`: Atkinson Hyperlegible and Crimson Pro, self-hosted (SIL Open Font License,
  see `fonts/LICENSE.txt`)

## Publishing (one-time setup)

Settings → Pages → Build and deployment → Source: **Deploy from a branch**, Branch:
**main**, folder **/ (root)**. GitHub republishes the site after every push to `main`;
watch the "pages build and deployment" run in the Actions tab.

To run it locally: `python3 -m http.server` in this folder, then open
http://localhost:8000.
