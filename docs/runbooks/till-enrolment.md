# Enrolling a till

**Who:** a branch manager at the shop, with someone holding `admin.terminal.manage` in the back office.

1. **Back office** — Terminals → *New terminal*: company, branch, a name and a terminal code (the code
   becomes the ticket number's suffix, `POS-<code>`, §4.14). A one-time enrolment code is shown **once**.
   It works for an hour unless a different lifetime was set when it was issued.
2. **Till** — install `dulja-pos-<version>-windows-x64.exe` (a build made for this server: the API address is
   baked in when it is built, ADR 0093, and nothing at the shop sets it), open *Dulja POS*, and on
   *Enrol till* type the code. A preview build (version `…-preview.N`) is built against `https://api.invalid`
   and cannot enrol anywhere; it is for install and smoke checks only.
   The till generates its own key pair, sends only the public half, and stores the private half through
   Windows' own credential encryption (`safeStorage`). Nobody, including the office, ever sees it.
3. The till pulls the catalogue. When the indicator shows a revision and a recent time, it can sell.

## If the code expired before the till used it

The till answers *"That enrolment code was not accepted. Check it against the back office; if it has expired or
was already used, ask for a new one."* (*"لم يُقبل رمز التسجيل هذا. تحقّق منه مقابل مكتب الإدارة؛ وإن كانت صلاحيته
قد انتهت أو استُخدم من قبل، فاطلب رمزًا جديدًا."*). The server gives the same answer for a code that is mistyped,
expired or already used, and does not say which (LEGACY-025). **Retype the code first**: while a mistyped original
is still live, a second code for the same terminal code is refused (below). If it still fails, issue a new code. The same terminal code may be used again: an enrolment code nobody redeemed in time stops
holding its terminal code when it expires. While a code is still live, or once a till has enrolled with it,
its terminal code is taken and a second code for it is refused (409, `ERR_CONFLICT_UNIQUE`).

## If a till is replaced or reinstalled

Issue a **new** enrolment code and enrol the new machine. Then **revoke the old terminal** in the back
office; its tickets stay in the ledger and its number series is not reused.

> **Before revoking, re-enrolling or wiping a till, close its shift and bring the indicator's *Pending sync*
> count (*بانتظار المزامنة*) to zero.** Unsent tickets are the only thing on a till that exists nowhere else.
> Connect the till to the network and wait for the count to reach zero.
>
> The till **refuses to enrol** while its local database holds an open shift or anything unsent — tickets,
> shift and till events, clock-ins and clock-outs, or customers created at the till. The screen does not name
> that cause. It shows the general refusal and then *"That is not a valid entry."* (*"هذا الإدخال غير صالح."*),
> which is also what a code gets when it is not 32 characters of capital letters A–Z and digits 2–7. A
> well-formed code that is wrong, expired or used gets the enrolment-code answer above instead. So first check
> the code against the back office, character for character, in capitals. If it matches and the till still
> answers *"That is not a valid entry."*, the code is not the problem: do not issue another code or reinstall, and follow *If a till was revoked, or failed, with
> unsent tickets* below. A till that is not enrolled offers no sign-in, so its shift cannot be closed from it.
> Re-enrolment never carries unsent tickets across to a new enrolment. A clock-in or clock-out travels to the
> server only with the next sale, so one taken after the last sale still holds the till back after the
> *Pending sync* count reaches zero.
>
> **Never revoke a terminal, or wipe its disk, while its *Pending sync* count is not zero.** A revoked
> terminal's requests are refused (`ERR_TERMINAL_REVOKED`), so it can no longer send what it holds, and the
> refusal above stops it re-enrolling.

## If a till was revoked, or failed, with unsent tickets

Do not delete, reinstall or re-enrol it, and do not delete its local database. **Preserve the whole POS
user-data directory** — copy it somewhere safe as it is — and contact support with the terminal code and the
*Pending sync* count the indicator last showed. Deleting the till's SQLite file, or any outbox row, discards the
unsent sales for good (`docs/runbooks/pos-till.md`).

## If the till says the signature is invalid

The till's clock is wrong. Signed calls carry a timestamp and the server refuses one that is far out of
date. Fix the Windows clock; nothing needs re-enrolling.

The same refusal, saying the signed request was *already used*, answers a copy of a request the server has
already served. The till signs every call afresh, so its own traffic does not cause it; the copy is refused and
the till needs nothing.

