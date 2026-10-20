# Brawl Stars Analytics

A personal stats tracker for player **#8YRJ090Q2** and club **#2U0RP22G2 (Stargazers)**. It shows trophy growth, win rate, modes and maps, brawlers, the club member board, and goals with ETAs.

## How it works

- **The page** (`index.html`) is a single static file served by GitHub Pages. It reads saved stats from Supabase with the public, read-only key.
- **The server function** (`supabase/functions/brawl`) fetches fresh data from BrawlTime and saves a reading plus any new battles. The sync button calls it, and so does the app while it's open (every 3 minutes). It also adds and removes goals, but only for someone who knows the owner code.
- **The schedule.** A Supabase cron job calls the function every 15 minutes, so history builds up even when the app is closed.
- **Club data.** Club member lists, from BrawlTime and from Supercell's own API, can be up to about an hour behind the game. With an official Brawl Stars API key saved as the `BS_API_KEY` secret in Supabase, the function reads every member's live profile through RoyaleAPI's proxy (`bsproxy.royaleapi.dev`; allow IP `45.79.218.79` on the key) and adds up the club total itself. Without a key, only your own row is live.
- **Notifications.** On the Goals tab, after unlocking with the owner code, each device can turn on alerts: goals reached, trophy milestones (every 500 for you, every 5,000 for the club), members joining or leaving, and a nightly recap at 10 PM Shanghai time. On iPhone and iPad this works once the app is added to the Home Screen and opened from there. The server signs notifications with its own keys (made on first use, kept private in the database).
- **Opening fast.** The page, fonts and icons stay on your device (`sw.js`), and so do the stats it has already downloaded. The app opens instantly and then fetches only what's new. An update to the site shows up the second time you open it.
- **Lean storage.** When a check finds nothing new, the server marks the last reading as confirmed instead of saving a copy. Brawler lists are saved as changes only.
- **The database** (`supabase/schema.sql`) has five tables:
  - `readings`: one row per update.
  - `battles`: one row per battle, keyed by time.
  - `goals`.
  - `settings`: private. It holds the owner-code hash, the current full brawler and club lists, and the push keys.
  - `push_subs`: private. Devices that turned on notifications.

  Anyone can read the first three. Only the function can write to any of them, or read the last two.

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
- Fonts: Chakra Petch and JetBrains Mono, both under the SIL Open Font License (see `fonts/`).
- Game art is loaded from Brawlify and BrawlTime. This app is unofficial and not endorsed by Supercell; see Supercell's Fan Content Policy.
