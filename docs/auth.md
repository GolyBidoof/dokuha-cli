# Signing in: BookWalker and Kindle

Most volumes need nothing at all. This page is about the two stores that do, what to hand the CLI, and where to get it.

## What needs no account

CMOA, ebookjapan, BookWalker and k-manga all publish a free volume or a 試し読み preview for a title, and this CLI takes them anonymously:

```sh
dokuha 'https://www.cmoa.jp/title/000000/' --series
```

No cookies, no login, no flags. With `--download-samplers` the series walk carries on past the free volumes into each remaining volume's preview, which is written to its own `（試し読み）` folder so it can never overwrite the whole volume.

**Kindle is the exception.** An Amazon manga volume is never public, not even a limited-time-free one, so there is no anonymous route at all. Every Kindle volume, sampler included, needs a signed-in `read.amazon.co.jp` session.

## How to pass cookies

Both `--bw-cookie` and `--kindle-cookie` accept the same five forms, and both are repeatable. Whatever you pass is merged into one header, and where two values share a name the first one wins, so the order you write them in is the order that counts.

| Form | Example |
| --- | --- |
| A raw `Cookie:` header | `--bw-cookie 'bwmember=...; lbwsid=...'` |
| A "Copy as cURL" command | paste the whole thing from the browser's developer tools |
| A file, with `@` | `--bw-cookie @~/cookies.txt` |
| A path, without `@` | `--bw-cookie ~/cookies.txt` |
| Standard input | `--bw-cookie - < cookies.txt` |

An `@FILE` that does not exist is rejected while the options are parsed, so a mistyped path is one clear message at startup rather than one failure per volume.

Pasting the cURL command is the least error-prone form, because a cURL blob contains the cookie header, the `User-Agent` and any header the site requires, and the CLI normalises it down to the cookies.

### Copy as cURL, step by step

This is the whole setup, once per store.

1. Sign in to the store in your normal browser, not a private window; some stores only set the session cookie after a full page load.
2. Open the developer tools with `F12`, or right-click the page and choose Inspect.
3. Open the Network tab, then reload the page so requests are recorded.
4. Click a request whose domain is the store's own. The cookies you need are on the request to the site itself, not to an analytics or CDN host.
5. Right-click that request, choose Copy, then Copy as cURL. Chrome and Edge also offer "Copy as cURL (bash)"; either is fine.
6. Paste it into the flag. On macOS you can pipe the clipboard straight in:

   ```sh
   dokuha 'https://bookwalker.jp/.../' --bw-cookie "$(pbpaste)"
   ```

   On other systems, paste it yourself inside single quotes:

   ```sh
   dokuha 'https://bookwalker.jp/.../' --bw-cookie 'curl "https://..." -H "cookie: ..."'
   ```

If your clipboard holds a bare `cookie:` header rather than a cURL command, that works too: the forms in the table above are all accepted.

## BookWalker

**Only needed for titles already in your library.** A free volume downloads with no cookies at all. `--bw-cookie` exists because a title you have paid for sits behind your account, and this CLI will not log in for you.

1. Sign in at <https://bookwalker.jp> in a normal browser.
2. Open any page on the site and copy the cookies as cURL from the network panel.
3. Pass them with `--bw-cookie`.

### The two halves live on different hosts

This is the part that catches people. The session that authorises a volume you own is split across two domains, and no single request carries both:

- `viewer.bookwalker.jp` holds `SESSION`, `u1` and `bid`
- `member.bookwalker.jp` holds the `JSESSIONID` that the member hand-off passes to `id.bookwalker.jp` as `kpid`

So copy from both. `--bw-cookie` is repeatable for exactly this reason:

```sh
dokuha 'de00000000-0000-4000-8000-000000000001' \
  --bw-cookie 'SESSION=...; u1=...; bid=...' \
  --bw-cookie 'JSESSIONID=...'
```

A signed-in session is recognised by any of `bwmember`, `bwlogin`, `lbwsid` or `cm_kp_login_account`. If none of those is present in what you passed, the run is treated as anonymous and a paid volume will be refused.

### `u1` is HttpOnly

`u1` is an `HttpOnly` cookie, so it never appears in `document.cookie` and a console snippet cannot read it. If the value you copied has no `u1` in it, supply it directly with `--bw-u1 <uuid>`. It only needs to be stable across the run.

### There is no sign-in flag

This build has no browser, so it cannot sign in for you. Sign in normally and pass cookies. `--bw-cookie` and `--kindle-cookie` are the only account paths.

### Free and sampler handshakes are cached

After a free or sampler handshake succeeds, the licence is written to a state file so a later run of the same volume does not handshake again. A signed-in run for a paid title does not write a cached licence, and does not read one.

The cache can be moved or disabled:

| Flag | Effect |
| --- | --- |
| `--bw-state FILE` | put the cached licence somewhere else (default `~/.bwdd-cli/free-session.json`) |
| `--no-state` | neither read nor write a saved session, for either account store |

`--no-state` is also the first thing to try when a free run that used to work starts refusing a licence: a stale cache is indistinguishable from an expired session.

## Kindle

**Always needed**, as above. The same five cookie forms apply to `--kindle-cookie`.

1. Sign in at <https://read.amazon.co.jp/manga/> in a normal browser. The Japan store is the only one this CLI speaks to.
2. Copy the cookies as cURL from any page on that site.
3. Pass them with `--kindle-cookie`.

The session is saved to `~/.bwdd-cli/kindle-session.json`, written `0600` inside a `0700` directory, and reused on later runs. Point it elsewhere with `--kindle-state FILE`, or turn it off with `--no-state` to force a fresh handshake every run.

If the run stops with "Kindle needs signed-in read.amazon.co.jp cookies, and none were found", the message that follows says which source was consulted and where the file is, so you know whether to refresh the cookie or delete the cache.

## Kindle Unlimited

A Kindle Unlimited volume is borrowed, not owned, and the CLI borrows it, downloads it and returns it. You will see the row tagged `KDUL` rather than `KDL`, and the volume counts against your own loan slots while it is open.

- **No extra cookies.** Unlimited rides on the same `read.amazon.co.jp` session as everything else. There is nothing separate to configure.
- **Loans are capped at six open at a time.** The queue in front of the borrow slot respects that ceiling and returns each volume as soon as it is on disk, so a long run does not accumulate loans. `--bridge-parallel` widens or narrows the bridge stage, not this.
- **A volume that cannot be borrowed is skipped, not failed.** A title outside your subscription resolves to a skip with a reason, and the run carries on. The same is true when a loan is refused because every slot is busy.
- **`--series` walks by borrowing forward.** A Kindle series walk is one request per volume rather than one listing page, so it is the slowest discovery in the CLI. The walk stops at the end of the series, bounded internally at 200 volumes.

If a borrowed volume reports that Unlimited is unavailable when you expected it to be, the usual cause is an expired session rather than an expired subscription: refresh the cookies first, and only then look at the account.

## Housekeeping

Session and licence material lives under `~/.bwdd-cli/`:

| Path | What it is |
| --- | --- |
| `kindle-session.json` | your `read.amazon.co.jp` cookie header, `0600` |
| `free-session.json` | cached BookWalker licences for free and sampler handshakes |

Both are covered by `.gitignore` in this repository, by name, so a stray copy cannot be committed by accident. `.bwdd-cli/`, `licence-*.json` and `kindle-session.json` are the names to check before sharing anything.

## When a signed-in run stops working

In the order worth trying:

1. **The session expired.** Cookies are the most common casualty. Copy fresh ones; nothing else needs to change.
2. **The cached licence is stale.** Add `--no-state` for one run. If that works, the cache was the problem and the next normal run rewrites it.
3. **BookWalker needs the second host.** If a title you own is refused but a free one downloads, check that you passed `JSESSIONID` from `member.bookwalker.jp` as well as the viewer cookies.
4. **`u1` is missing.** It is `HttpOnly`; pass it with `--bw-u1`.
