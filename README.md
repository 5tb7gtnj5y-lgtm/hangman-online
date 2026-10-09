# Hangman Online

A traditional hangman game played by two people on separate phones or computers.

## What is included

- Create a room and share its link or eight-character code.
- Two player places, with optional names and no account registration.
- The first player sends a word. The answer stays on the server until the round ends.
- The second player guesses letters with buttons or a keyboard.
- Both players see the guesses and hangman drawing update live.
- Six wrong guesses finish a round. A correct answer or a loss swaps the roles automatically.
- Reconnection restores your place on the same browser and phone.
- Unused rooms expire after 24 hours of inactivity.
- The original pass-and-play game is preserved in backup/Hangman-Original.html.

## Current status

The game is built and its room server has passed Cloudflare local-runtime integration checks. It has not been published to your Cloudflare account: the build session had no Cloudflare credentials and the dashboard's sign-in verification was unavailable. Your original ChatGPT Site remains unchanged.

Actual iPhone/Safari browser testing and a production two-phone check are still needed after publishing. The interface uses responsive layouts and native browser WebSockets.

## Publish from a Windows PC or Mac

1. Install Node.js LTS from https://nodejs.org if it is not already installed.
2. Extract this ZIP. Open a terminal in the Hangman-Online folder containing package.json and wrangler.jsonc. On Windows, open that folder in File Explorer, type `cmd` into the address bar and press Enter.
3. Run these commands, one at a time:

   ```sh
   npm install
   npx wrangler login
   npm run deploy
   ```

4. Sign into your existing Cloudflare account when Wrangler opens the browser. Keep your Workers plan on Free. The included configuration creates the SQLite-backed room binding automatically.
5. After publishing, Wrangler prints the real workers.dev website address. Open that address on both phones.

No AI service, API key, paid plan or custom domain is required. The free plan has usage limits, shared with your other Workers. If a free limit is exceeded, Cloudflare can stop the affected operations. Stay on Workers Free to avoid paid usage.

## Alternatively, connect GitHub to Cloudflare

1. Create a GitHub repository named hangman-online.
2. Upload the extracted files and folders to the repository root: package.json and wrangler.jsonc must be at the top level, alongside src and public. Do not upload the ZIP itself as the application.
3. In Cloudflare Workers & Pages, create a Worker connected to that repository.
4. Use `npx wrangler deploy` as its deploy command. There is no app build step; Cloudflare's build system installs the dependencies from package.json.
5. Deploy and open the website address Cloudflare provides.

This is a Worker with a shared-room server. Its included wrangler.jsonc configuration is needed for multiplayer; uploading only the public folder as a static site will not connect two phones.

## Play a game

1. On phone one, optionally enter your name and choose Create a game.
2. Choose Share game and send the link to the other person, or tell them the room code.
3. On phone two, open the link, optionally enter a name and choose Join.
4. The first player enters a secret word and chooses Send hidden word.
5. The second player guesses letters. The first player can watch the same progress live.
6. At the end, the answer is revealed and roles automatically swap. The next word chooser gets the entry form immediately.

Both players need an internet connection. Keep using the same browser on each phone to retain your player place. Clearing its site data removes the saved player token. Sharing a room link does not share your player token.

## Local development and checks

```sh
npm install
npm run dev
npm test
npm run test:integration
```

The integration test runs a real local Cloudflare runtime. It checks assets, two-player limits, authentication, secret-word privacy, live updates, repeated letters, duplicate guesses, reconnecting, connection status, win/loss turn swaps, stale moves and persistence after restarting the runtime. It uses temporary test data and cleans it up.

## Technical details

- Vanilla HTML, CSS and JavaScript; no frontend build or paid libraries.
- Cloudflare Worker, SQLite-backed Durable Object, hibernating WebSockets.
- The server enforces player roles and round numbers, validates words and guesses, and stores only hashes of player tokens.
- The answer is omitted from state returned to both players until the round ends.
- Credentials travel in an authenticated WebSocket message or POST body, never in the share link or WebSocket URL.
- Restart recovery and room cleanup are included.

Cloudflare documentation:
- https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/workers/wrangler/configuration/

## Backups and rollback

Your original pass-and-play site is unchanged. Open backup/Hangman-Original.html to play that version offline on a computer. The online game uses a separate Worker name, hangman-online, so publishing it does not replace your other Workers.

For future online updates, retain the existing Worker name and Durable Object migration tag. Run npm run deploy from the updated project. Do not rename the room class or delete its binding to perform a routine update.
