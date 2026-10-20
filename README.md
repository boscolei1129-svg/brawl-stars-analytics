# Brawl Stars Analytics

A personal stats tracker for player **#8YRJ090Q2** and club **#2U0RP22G2 (Stargazers)**. It shows trophy growth, win rate, modes and maps, brawlers, the club member board, and goals with ETAs.

## How it works

- **The page** (`index.html`) is a single static file served by GitHub Pages. It reads saved stats from Supabase with the public, read-only key.
- **The server function** (`supabase/functions/brawl`) fetches fresh data from BrawlTime and saves a reading plus any new battles. The sync button calls it, and so does opening the app when the data is more than 10 minutes old. It also adds and removes goals, but only for someone who knows the owner code.
- **The schedule.** A Supabase cron job calls the function every 15 minutes, so history builds up even when the app is closed.
- **The database** (`supabase/schema.sql`) has four tables:
  - `readings`: one row per update.
  - `battles`: one row per battle, keyed by time.
  - `goals`.
  - `settings`: holds only a hash of the owner code.

  Anyone can read the first three. Only the function can write to any of them.

## Owner code

Goal editing is locked until you enter the owner code on the Goals tab. Each device remembers it after that. The code isn't stored anywhere in this repo. Only its SHA-256 hash lives in the database.

To change the code, run this in the Supabase SQL editor, replacing `NEWCODE` with an uppercase code:

```sql
update settings set value = encode(sha256(convert_to('NEWCODE', 'UTF8')), 'hex') where key = 'owner_code_sha256';
```

## Add to your home screen

- **iPhone:** open the site in Safari, tap Share, then tap **Add to Home Screen**.
- **Android:** open the site in Chrome, open the menu, then tap **Add to Home screen**.

## Notes

- Trophy history starts on Oct 19, 2026, when tracking began.
- Solo Showdown counts a top-5 finish as a win, as BrawlTime does.
- A free Supabase project can pause after a week without activity. The cron job's calls should keep it awake. If it ever pauses, restore it from the Supabase dashboard.
