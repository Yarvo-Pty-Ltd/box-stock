# Box Stock

Each Renegade box carries an NFC tag. Tapping it with a phone opens that box's
page at https://yarvo-pty-ltd.github.io/box-stock/, where each item has a
plus and a minus button. The counts live in a Google Sheet behind a Google
Apps Script web app (`apps-script/Code.gs`), and every change is written to
the Sheet's `Log` tab.

## Set up the sheet (once)

1. Create a Google Sheet named `Box Stock`.
2. Open Extensions > Apps Script, replace the editor contents with
   `apps-script/Code.gs`, and save.
3. Select `setup` in the function list and click Run. Approve the access
   prompt. The execution log prints `Key: <16 characters>`. Keep the key.
4. Deploy > New deployment > type Web app. Set Execute as: Me and
   Who has access: Anyone. Deploy, then copy the Web app URL.
5. Put that URL in `config.js` as `window.STOCK_API` and push.

The Web app URL is safe to commit. The key is not: it goes only on the tags.

## Write a tag

1. Open `https://yarvo-pty-ltd.github.io/box-stock/#k=<key>` once on your
   phone. The phone keeps the key after that.
2. Add the box, open it, and tap Copy link at the bottom of its page.
3. In an NFC writer app (NFC Tools on iPhone or Android), write the link to
   an NTAG215 sticker as a URL record, then stick it on the box.

## Change the key

Anyone who reads a tag has the key. To cut off old links, run `newKey` in the
Apps Script editor, then rewrite every tag with the new link.

## Change the script

After editing `Code.gs`, use Deploy > Manage deployments > Edit > New version.
A new deployment instead of a new version changes the URL.

Tests, run from this folder: `node gates/test-apps-script.js` (script against
a mock sheet) and `node gates/smoke.js` (page in headless Edge against the
mock).
