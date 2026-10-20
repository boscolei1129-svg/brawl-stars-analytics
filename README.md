# Brawl Stars Analytics

A stats tracker for Brawl Stars players and their clubs. It shows trophy growth, win rate, modes and maps, brawlers, the club member board, when club members play, and goals with ETAs. It started with player **#8YRJ090Q2** and club **#2U0RP22G2 (Stargazers)**; anyone can add another player.

## How it works

- **Welcome.** A phone opening the app for the first time sees "hello" written out in one stroke, then a four-step tour of what the app does and how player codes work. Open the app with `?welcome` at the end of the link to see it again; "How it works" on the home screen replays the tour.
- **Home screen.** After the welcome, a new phone sees the home screen: type a player tag, see the player (and their club) straight away, pick the club to follow (their own, another one, or none) and a code, and start tracking. After that the app opens straight to that player. Tap the player's name at the top to switch players or add another. Each phone keeps its own list of players; removing one only takes it off that phone.
- **Players.** Up to 20 players are tracked at once. A player nobody opens for 30 days pauses, and opening it again wakes it up. Anyone can view any tracked player (game stats are public), but each player's goals and alerts need that player's code, chosen when it was added. A player added with their own club follows them if they move to another.
- **The page** (`index.html`) is a single static file served by GitHub Pages. It reads saved stats from Supabase with the public, read-only key.
- **The server function** (`supabase/functions/brawl`) fetches fresh data from BrawlTime and saves a reading plus any new battles. The sync button calls it, and so does the app while it's open (every 3 minutes). It also adds and removes goals, but only for someone who knows that player's code.
- **The schedule.** A Supabase cron job refreshes every player every 15 minutes (each one on its own minute), so history builds up even when the app is closed.
- **Club data.** Club member lists, from BrawlTime and from Supercell's own API, can be up to about an hour behind the game. With an official Brawl Stars API key saved as the `BS_API_KEY` secret in Supabase, the function reads every member's live profile through RoyaleAPI's proxy (`bsproxy.royaleapi.dev`; allow IP `45.79.218.79` on the key) and adds up the club total itself. Without a key, only the player's own row is live.
- **Club activity.** Brawl Stars doesn't share who is online, so the app goes by play instead. The function reads each member's last 25 battles (at most every 4 minutes) and groups battles less than 20 minutes apart into play sessions. A member counts as online if they finished a battle in the last 12 minutes. The Activity tab shows who is playing now, a 24-hour timeline for each of the last 7 days, the club's usual hours by weekday (a heatmap that fills in over two weeks), and the most active members this week. Tap a member for their sessions and usual hours. Times are in the viewer's own time zone.
- **Notifications.** On the Goals tab, after unlocking with the player's code, each device can turn on alerts for that player: goals reached, trophy milestones (every 500 for you, every 5,000 for the club), members joining or leaving, and a daily recap at a time it picks (in the phone's own time zone). The recap covers the last 24 hours: your battles, trophies and win rate, plus the trophies the other members won for the club while in it, so new members joining (and your own trophies) don't count. On iPhone and iPad this works once the app is added to the Home Screen and opened from there. The server signs notifications with its own keys (made on first use, kept private in the database).
- **Opening fast.** The page, fonts, icons and game pictures stay on your device (`sw.js`), and so do the stats it has already downloaded. Pictures for the other tabs are fetched in the background after the app opens, so every tab shows up fully drawn. The app opens instantly and then fetches only what's new. An update to the site shows up the second time you open it.
- **Lean storage.** When a check finds nothing new, the server marks the last reading as confirmed instead of saving a copy. Brawler lists are saved as changes only.
- **The database** (`supabase/schema.sql`) has eight tables:
  - `profiles`: every tracked player and the club it follows.
  - `readings`: one row per update, per player.
  - `battles`: one row per battle, keyed by player and time.
  - `goals`: per player.
  - `sessions`: club members' play sessions.
  - `profile_codes`: private. Each player's code, as a SHA-256 hash.
  - `settings`: private. The current full brawler and club lists for each player, and the push keys.
  - `push_subs`: private. Devices that turned on notifications, per player.

  Anyone can read the first five. Only the function can write to any of them, or read the last three.

## Codes

Each player's goals and alerts are locked until that player's code is entered on the Goals tab. The person who adds a player picks its code, and their phone is unlocked straight away; other phones enter it once and remember it. Codes aren't stored anywhere in this repo. Only their SHA-256 hashes live in the database.

To change a player's code, run this in the Supabase SQL editor, replacing `TAG` with the player tag (no #) and `NEWCODE` with an uppercase code:

```sql
update profile_codes set code_sha256 = encode(sha256(convert_to('NEWCODE', 'UTF8')), 'hex') where tag = 'TAG';
```

## Add to your home screen

- **iPhone:** open the site in Safari, tap Share, then tap **Add to Home Screen**.
- **Android:** open the site in Chrome, open the menu, then tap **Add to Home screen**.

## Notes

- Each player's trophy history starts when it was added (Oct 19, 2026 for #8YRJ090Q2). Club activity starts on Oct 20, 2026; days before that only include each member's last 25 battles.
- Solo Showdown counts a top-5 finish as a win, as BrawlTime does.
- A free Supabase project can pause after a week without activity. The cron job's calls should keep it awake. If it ever pauses, restore it from the Supabase dashboard.
- Fonts: Chakra Petch and JetBrains Mono, both under the SIL Open Font License (see `fonts/`). The welcome "hello" is traced from the letterforms of Dancing Script (SIL Open Font License).
- Game art is loaded from Brawlify and BrawlTime. This app is unofficial and not endorsed by Supercell; see Supercell's Fan Content Policy.
