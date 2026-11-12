# Box Stock

Each Renegade box carries an NFC tag. Tapping it with a phone opens that box's
page at https://yarvo-pty-ltd.github.io/box-stock/, where each item has a
plus and a minus button.

The counts live in `stock.json` in the private repo
`Yarvo-Pty-Ltd/box-stock-data`. Every save is a commit, so the repo's history
is the stock log: `50 mm PVC elbows -2 = 10`. Taps made in a burst go out as
one commit.

## Make the tag code (once)

The tag code is a fine-grained GitHub token that can only read and write
`box-stock-data`.

1. Open https://github.com/settings/personal-access-tokens/new
2. Name: `box-stock tags`. Resource owner: `Yarvo-Pty-Ltd`.
3. Expiration: the longest offered. GitHub emails before it runs out.
4. Repository access: Only select repositories > `box-stock-data`.
5. Permissions > Repository > Contents: Read and write. Nothing else.
6. Generate, then copy the token (`github_pat_...`). If the org asks for
   approval, approve it under the org's Settings > Personal access tokens.

The token goes only on the tags and phones. Never commit it.

## Write a tag

1. On your phone, open https://yarvo-pty-ltd.github.io/box-stock/ and paste
   the token into "No tag yet?". The phone keeps it after that.
2. Add the box, open it, and tap Copy link at the bottom of its page.
3. In an NFC writer app (NFC Tools on iPhone or Android), write the link to
   an NTAG215 sticker as a URL record, then stick it on the box.

## Add it to the home screen

Tap a box tag first, so the address carries the code, then in Safari use
Share > Add to Home Screen. The icon opens the app at that box. An NFC tap
still opens Safari, not the home screen app: iOS sends every tag to Safari.

`manifest.webmanifest` has no `start_url` on purpose. Without one the app
opens at the address it was added from, which is what carries the code.

Icons live in `assets/icons/`: `icon-1024.png` is the master (also the App
Store size), the others are cut from it. The art came from Codex imagegen,
and the wordmark on top is the site's own Inter Tight 700 in `#008A8A`.

## Change the code

Anyone who reads a tag has the code, and with it can change `stock.json`.
The history keeps every version, so a bad change can be reverted. To cut off
old tags, delete the token in GitHub settings, make a new one, and rewrite
every tag.

## Undo a wrong count

Edit the number on the box page, or revert the commit in `box-stock-data`.

Tests, run from this folder: `node gates/test-store.js` (stock rules and two
phones saving at once) and `node gates/smoke.js` (page in headless Edge
against a fake GitHub API).
