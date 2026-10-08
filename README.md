# Last Card

A card game for Josh's group chat, live at https://joshuaamaine.github.io/Last-card/

Friends open the link, type a name, take a seat and play. No accounts, no app. The classic rules: match the top card by color, number or symbol, Skip / Reverse / +2 / Wild / Wild +4, call "Last card!" before you're down to one, and anyone can catch you if you forget.

## How it works

- **Tables:** the plain link is table `main`. `?t=anything` (letters, numbers, dashes) is a separate table, and the lobby's "Start a private table" makes a random one. A table stays put between visits.
- **Players:** each browser gets a random player id saved on that device, so reopening the link puts you back in your seat. On a new phone or browser, sitting down with the same name takes your old seat back (cards and wins included) as long as that seat's player isn't online. Everyone picks a face; wins show as a badge on it.
- **Saving moves:** every player's browser keeps a copy of the table, applies a move with the rules in `engine.js`, and saves it through the Supabase function `lc_save`. The save only goes through if nobody else saved first; otherwise the browser reloads the table and tries the move again. Supabase Realtime pushes each save to everyone at the table, and the page also re-checks every few seconds.
- **Bots:** run by one browser at the table (the online player with the lowest id). If that browser goes quiet, the others take over after a few seconds.
- **Honor system:** the whole table, including everyone's cards, is readable by anyone at the table with browser dev tools. Fine for friends.

## Files

- `index.html`: the page.
- `style.css`: all styles, light and dark.
- `engine.js`: the game rules as pure functions over a JSON table. Shared by the page and `tools/check.js`.
- `app.js`: the page logic: Supabase sync, presence, bots, rendering.
- `config.js`: Supabase project URL and publishable key. Public by design; never put the secret or service_role key here.
- `supabase/schema.sql`: the one-time database setup. Paste it into the Supabase SQL Editor and run it.
- `og.png`: the link preview iMessage shows. `icon-180.png` / `favicon.svg`: icons.
- `tools/check.js`: `node tools/check.js` plays 1,200 bot rounds and checks the rules hold.

## Setup (one time)

1. Supabase: run `supabase/schema.sql` in the SQL Editor.
2. Put the project URL and publishable key in `config.js`.
3. GitHub: Settings → Pages → Deploy from a branch → `main`, `/ (root)`.

If `config.js` isn't filled in, the page runs as a practice table against bots on one device.

## Housekeeping

Clear old tables in the SQL Editor:

```sql
delete from public.lc_rooms where updated_at < now() - interval '30 days';
```

Reset the main table: `delete from public.lc_rooms where code = 'main';`
