# Signing in: BookWalker, Kindle and Kindle Unlimited

Most volumes need nothing at all. This page is about the ones that do, what to
hand the CLI, and where to get it.

## What needs no account

CMOA, ebookjapan, BookWalker and k-manga all publish a free volume or a
`試し読み` preview for any title, and this CLI will take them anonymously:

```
dokuha 'https://www.cmoa.jp/title/000000/' --series
```

No cookies, no login, no flags. Add `--download-samplers` and the walk carries on
past the free volumes into each remaining volume's preview, which is written to
its own `（試し読み）` folder so it can never overwrite the whole volume.

**Kindle is the exception.** An Amazon manga volume is never public, not even a
limited-time-free one, so there is no anonymous route at all. Every Kindle volume,
sampler included, needs a signed-in `read.amazon.co.jp` session.

## How to pass cookies

Both `--bw-cookie` and `--kindle-cookie` accept the same five forms, and both are
repeatable. Whatever you pass is merged into one header, and where two values
share a name the first one wins, so the order you write them in is the order that
counts.

| Form | Example |
| --- | --- |
| A raw `Cookie:` header | `--bw-cookie 'bwmember=...; lbwsid=...'` |
| A "Copy as cURL" command | paste the whole thing from the browser's developer tools |
| A file, with `@` | `--bw-cookie @~/cookies.txt` |
| A path, without `@` | `--bw-cookie ~/cookies.txt` |
| Standard input | `--bw-cookie - < cookies.txt` |

Pasting the cURL command is the least error-prone, because a cURL blob contains
the cookie header, the `User-Agent` and any header the site requires, and the CLI
normalises it down to the cookies.

## BookWalker

**Only needed for titles already in your library.** A free volume downloads with
no cookies at all; `--bw-cookie` exists because a title you have paid for is
behind your account, and this CLI will not log in for you.

1. Sign in at <https://bookwalker.jp> in a normal browser.
2. Open any page on the site and copy the cookies as cURL from the network panel.
3. Pass it with `--bw-cookie`.

### The two halves live on different hosts

This is the part that catches people. The session that authorises a volume you
own is split across two domains, and no single request carries both:

- `viewer.bookwalker.jp` holds `SESSION`, `u1` and `bid`
- `member.bookwalker.jp` holds the `JSESSIONID` that the member hand-off passes
  to `id.bookwalker.jp` as `kpid`

So copy from **both**. `--bw-cookie` is repeatable for exactly this reason:

```
dokuha 'de00000000-0000-4000-8000-000000000001' \
  --bw-cookie 'SESSION=...; u1=...; bid=...' \
  --bw-cookie 'JSESSIONID=...'
```

A signed-in session is recognised by any of `bwmember`, `bwlogin`, `lbwsid` or
`cm_kp_login_account`. If none of those is present in what you passed, the CLI
treats the run as anonymous and the volume will be refused.

### `u1` is HttpOnly

`u1` is an `HttpOnly` cookie, so it never appears in `document.cookie` and a
console snippet cannot read it. If the value you copied has no `u1` in it, supply
it directly with `--bw-u1 <uuid>`. It only needs to be stable across the run.

### `--bw-login` does not exist

There is a flag shaped like it and it refuses: this build has no browser, so it
cannot sign in for you. Sign in normally and pass cookies.

### Licences are cached

After a successful handshake the licence is written to a state file, so a later
run of the same volume does not handshake again. It lives beside the other
session material (see below) and can be controlled with:

| Flag | Effect |
| --- | --- |
| `--bw-state FILE` | put the cached licence somewhere else |
| `--no-state` | neither read nor write it, for either account |

`--no-state` is also the first thing to try when a run that used to work starts
refusing a licence: a stale cache is indistinguishable from an expired session.

## Kindle

**Always needed**, as above. The same five forms apply to `--kindle-cookie`.

1. Sign in at <https://read.amazon.co.jp/manga/> in a normal browser. The Japan
   store is the only one this CLI speaks to.
2. Copy the cookies as cURL from any page on that site.
3. Pass them with `--kindle-cookie`.

The session is saved to `~/.bwdd-cli/kindle-session.json`, written `0600` inside
a `0700` directory, and reused on later runs. Point it elsewhere with
`--kindle-state FILE`, or turn it off with `--no-state` to force a fresh handshake
every run.

If the run stops with *"Kindle needs signed-in read.amazon.co.jp cookies, and
none were found"*, the message that follows says which of the two sources was
consulted and where the file is, so you know whether to refresh the cookie or
delete the cache.

## Kindle Unlimited

A Kindle Unlimited volume is **borrowed**, not owned, and the CLI borrows it,
downloads it and returns it. You will see the row tagged `KDUL` rather than
`KDL`, and the volume counts against your own loan slots while it is open.

- **No extra cookies.** Unlimited rides on the same `read.amazon.co.jp` session
  as everything else. There is nothing separate to configure.
- **Loans are capped at six open at a time.** The queue in front of the borrow
  slot respects that ceiling and returns each volume as soon as it is on disk, so
  a long run does not accumulate loans. Pass `--bridge-parallel` to widen or
  narrow the bridge stage, not this.
- **A volume that cannot be borrowed is skipped, not failed.** A title outside
  your subscription resolves to a skip with a reason, and the run carries on.
  The same is true when a loan is refused because every slot is busy.
- **`--series` walks by borrowing forward.** A Kindle series walk is one request
  per volume rather than one listing page, so it is the slowest discovery in the
  CLI. `--kindle-max-volumes N` caps it (default 200) and the walk stops at the
  end of the series or the cap, whichever comes first.

If a borrowed volume reports that Unlimited is unavailable when you expected it
to be, the usual cause is an expired session rather than an expired subscription:
refresh the cookies first, and only then look at the account.

## Housekeeping

Session and licence material lives under `~/.bwdd-cli/`:

| Path | What it is |
| --- | --- |
| `kindle-session.json` | your `read.amazon.co.jp` cookie header, `0600` |
| `free-session.json` | cached BookWalker licences |

Both are covered by `.gitignore` in this repository, and both are ignored by
name so a stray copy cannot be committed by accident. To be sure nothing
sensitive is about to be shared, `.bwdd-cli/`, `licence-*.json` and
`kindle-session.json` are the names to check for.

## When a signed-in run stops working

In the order worth trying:

1. **The session expired.** Cookies are the most common casualty. Copy fresh
   ones; nothing else needs to change.
2. **The cached licence is stale.** Add `--no-state` for one run. If that works,
   the cache was the problem and the next normal run rewrites it.
3. **BookWalker needs the second host.** If a title you own is refused but a free
   one downloads, check that you passed `JSESSIONID` from `member.bookwalker.jp`
   as well as the viewer cookies.
4. **`u1` is missing.** It is `HttpOnly`; pass it with `--bw-u1`.
