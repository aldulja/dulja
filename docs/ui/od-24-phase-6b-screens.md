# OD-24 — the Phase 6B till screens (Plan 6B Task 11)

**Status:** built on the **authorized default baseline**, with **legacy parity unproven**. No owner material was
supplied. `docs/owner/od-24/6b/` does not exist, and there are no screenshots, no operator description and no
legacy keyboard map. The owner authorized the plan's screen workflows and keyboard maps as Phase 6's UI baseline
(`docs/review/2026-10-07-phase-6-decisions.md`, "Implementation authorization"). That record says:
*"Unavailable legacy reference material means legacy parity remains unproven."* This file is Task 11 Step 1's gate
record, the counterpart of the earlier phases' `docs/ui/od-24-phase-*.md` files. It writes out the key map the
till actually implements, so the owner can check it line by line against what the shop uses today.

Every key below comes from `apps/pos/src/renderer/app.tsx` (one `keydown` listener on `window`, so a key means
the same thing on every screen) and from the forms' own `Enter` submission. **None of them is the shop's.** Each
is the plan's default or the browser's. A row marked *Tab or click* has no shortcut.

## How the keys behave

- **F2, F4, F8, F10 and Escape** act from anywhere on the signed-in till, including from inside a text field.
  They act only while no operation is running and neither the payment screen nor a receipt is showing. A
  ticket under payment is finished or cancelled before the cashier moves away (`docs/runbooks/pos-till.md`).
- **F8** acts only on the sell screen, and only when the basket holds a line, because the review button is
  disabled otherwise.
- **Escape** returns to the sell screen and puts the cursor in the barcode field.
- **Enter** submits the form the cursor is in. A keyboard-wedge scanner types the code and presses Enter (D18,
  spec:133). A scan is the same as typing everywhere except the opening float and the counted cash, where a
  scan is refused (below, 2026-11-15).
- **Enter never runs an action other than the one beside the field.** The void's fields and the cancellation's
  reason are forms of their own, whose submit button is that action's button, so Enter there does nothing until
  the button is enabled (a reason typed) and then voids or cancels. It can never close the shift or complete the
  sale. Fields that belong to no single action (a basket line's quantity, discount and override, the supervisor
  approval, a new customer's details) are in no form, so Enter there does nothing.
- **A void's and a cancellation's reason, supervisor and PIN are their own.** They are never the sell screen's
  supervisor approval, and they start empty each time the screen changes or a cashier signs in (a Lock also clears the sale's approval). A supervisor's PIN given for a
  discount or a price override therefore never voids or cancels a ticket, and the reason has to be typed on the
  screen that uses it.
- A scan that matches nothing is refused in the till's language (`pos.error.ERR_NOT_FOUND`). A search or price
  check that matches nothing says *No matching items* (`pos.noItems`). A lookup never shows *Completed.*
- **A field a scanner types into keeps what was looked up, selected and focused**: a barcode on the sell screen
  that adds nothing (unknown, refused, or one of several to choose from), and every lookup on the price-check
  screen, a refused one included. The next scan replaces the text instead of being appended to it, and a price
  check started with the button hands the cursor back to the field. A refused price check clears the previous
  item's price, so it is never read as the refused item's.
- The shortcut line at the foot of the screen (`pos.shortcuts`) lists F2, F4, F8, F10 and Escape in both
  languages, by the names printed on the keys (`F2` … `F10`, and `Esc` in Arabic). Until 2026-10-23 the Arabic
  line called them "key 2" to "key 10" in Arabic-Indic digits (`مفتاح ٢`), so a cashier who followed it could
  press the digit 2, which types into the scan field. It was also the only text on the till in a second
  numbering system. `tests/e2e/pos-rtl-parity.spec.ts` now fails on either.

## Step 1's table, filled with the implemented defaults

| Action | Key (implemented default, not the shop's) | Screen | Bridge call |
|---|---|---|---|
| Scan / enter an item | Type or scan into **Barcode**, then `Enter` | sell | `search({ barcode })`. One hit becomes a line; several are listed to choose from |
| Search by code or name | `Tab` to **Code or item name**, type, `Enter`; `Tab` to a hit, `Enter` | sell | `search({ text })` |
| Change quantity | *Tab or click*: the line's **Quantity** field | sell | — (local draft) |
| Line discount | *Tab or click*: the line's **Line discount** field | sell | — (local draft; `sell` checks the cashier's limit) |
| Price override | *Tab or click*: the line's **Override unit price** field; a supervisor's number, PIN and reason under **Supervisor approval** when the limit needs one | sell | — (local draft; approval travels with `sell`) |
| Void a line | *Tab or click*: the line's **Remove** button | sell | — (local draft) |
| Start a return | *Tab or click*: the **Return** checkbox (`Space`), the original ticket reference, then **Load original ticket** | sell | `receipt(original)`, then `sell` with `kind: "return"` |
| Review the ticket | `F8` | sell → payment | `sell` (and `receipt` for an on-account sale, which takes no payment) |
| Finish the sale | `F8`, then `Enter` in the amount field, which has the cursor. The receipt then has the cursor on **Next sale**: `Enter`, or scan the next item straight away | payment → receipt | `tender`, then `receipt` |
| Cancel an unpaid ticket | From the amount, `Shift+Tab` twice (past **Method**) to **Reason**, type it, `Enter`. Forward `Tab` reaches the payment's **Reference** instead, where `Enter` completes the sale. Enter in an empty reason does nothing | payment | `sell({ action: "cancel_draft" })` |
| Price check | `F2`, type or scan, `Enter`; scan again to check the next item | price check | `priceCheck({ text, barcode })`. Text with no space, up to 64 characters, is also sent as a barcode |
| Choose a customer | `F4`, type, `Enter`; `Tab` to a hit, `Enter` | customer | `search({ text, customer: true })` |
| Open the drawer | `F10`, then *Tab or click* **No sale** or **Drawer opened** | shift | `sell({ action: "no_sale" })` / `sell({ action: "drawer_open" })` (till events, T6) |
| Void a completed ticket | On its receipt, `Tab` to **Reason**, the first field after **Print** (only buttons come before it), then a supervisor's number and PIN, `Enter`; or `F10`, then **Ticket reference to void**, a reason and `Enter`. Enter before a reason (and, on the shift screen, a ticket reference) does nothing | receipt / shift | `sell({ action: "void" })` |
| Clock in / out | *Tab or click*: **Clock in** / **Clock out** in the navigation | any signed-in screen | `clock` |
| Close the shift | `F10`, type the counted cash, `Enter` (shows the count for review, the cursor on **Change count**), then `Tab` to **Confirm close** and `Enter`. ⚠️ **New keystroke for the owner to confirm** (2026-11-15) | shift | `closeShift` |
| Cancel another cashier's unfinished ticket | `F10`, then in **Unfinished tickets of another cashier**, a reason and `Enter`. Only a holder of `pos.shift.close_any` | shift | `sell({ action: "cancel_draft" })` |
| Back to selling | `Escape` | price check, customer, shift → sell | — |

The till's other actions have no shortcut. Each is *Tab or click*:

| Action | Screen | Bridge call |
|---|---|---|
| Enrol the till (one-time code, then `Enter`) | enrol | `enrol`, then `pull` |
| Sign in (employee number, PIN, then `Enter`) | sign in | `login` |
| Open the shift (opening float, typed, then `Enter`; the field starts empty and refuses a scan) | open shift | `openShift` |
| Print the receipt | receipt | `print` |
| Next sale | receipt | — |
| Switch cashier | navigation | `login({ logout: true })` |
| Refresh the catalogue | sign in, navigation | `pull` |
| Send pending work | navigation | `drain` |
| Switch language (English ↔ Arabic) | header | — |
| Status indicator (online or offline, catalogue revision and time, pending count) | every screen, polled every 5 s | `status` |

## Full review 2026-11-15: the till's cash keys (UI-02, UI-14, UI-15, UI-16, UI-22, POS-03, POS-04, POS-18)

⚠️ **For the owner to confirm.** The close's keystroke changed, from *F10, count, Enter* to *F10, count, Enter,
Tab, Enter*. The reviewer reproduced, in both languages, that one barcode scan on the shift screen (a
keyboard-wedge scanner types digits and Enter) closed the shift with the barcode as the counted cash, and that a
bare Enter closed it at 0. A close is final and the over/short posts from the count. The fix keeps F10 and keeps
the count field under the cursor, and adds:

- **The count's Enter shows it for review; it never closes.** The review lists the count beside the opening
  float and the till's own settled tenders by method (the same local aid the closed shift shows; the till still
  never computes expected cash, §4.10.1). The cursor is on **Change count**, so a stray Enter goes back to the
  count. **Confirm close** is one `Tab` further, a step no scanner makes.
- **A scan is refused in the opening float and the counted cash.** Four or more characters typed faster than
  30 ms a key, or more than nine digits before the decimal point, read as a scan: the field is emptied and the
  till says *That looked like a barcode scan, not a typed amount* (`pos.countLooksLikeScan`). Both fields start
  empty, so a bare Enter opens or closes nothing.
- **Amounts read as the cashier types them** (UI-14): Arabic-Indic digits, the Arabic decimal separator and a
  decimal comma (`12,50`). A comma followed by exactly three digits (`1,000`) is refused rather than read as one.
  An empty discount is no discount. A figure the till cannot read is refused as *That is not a valid entry*,
  followed by the field's name, never as the internal fault.
- **After a sale the cursor is on Next sale, and a scan there starts the next sale** with that item (UI-15).
- **A receipt that cannot be shown never strands the payment screen** (UI-16): the tender committed, so the
  screen says the sale is complete, with **Show receipt** and **Next sale** (the cursor's place).
- **A clicked button gives the cursor back** (UI-22): after No sale, Drawer opened, Clock in or out, Sync,
  Refresh catalogue or a line's Remove, the cursor returns to the scan field (sell) or the count (shift), so a
  scanner's Enter never clicks the button again. A language toggle clicked with the mouse does the same; reached by
  keyboard, it keeps the cursor.
- **Sync and Refresh catalogue run beside the sale** (POS-03): they no longer hold the till's keys, every request
  has a 20-second deadline, and the result is said in its own line — *Sync completed.* or *Sync failed. The till
  keeps your sales and will try again.* (POS-18: a failed push used to read *Completed.*).
- **Another cashier's unfinished ticket** (POS-04) is listed on the shift screen; a holder of
  `pos.shift.close_any` cancels it with a reason, recorded under their own name, and can then close. A change of
  signed-in cashier clears the last cashier's payment screen and basket.

## Where the build differs from the plan's table

- **Clock in and out are in the signed-in navigation, not on the sign-in screen.** The main process records
  attendance for the cashier who is signed in (`clock` requires a session), so a clock event needs a sign-in
  first.
- **Opening the drawer is on the shift screen (`F10`), not the sell screen.** The two till events sit beside
  the cash count they explain.
- **There is no `TILL_KEYS` module.** The one `keydown` listener in `app.tsx` is the application's single key
  map, which is the property the plan wanted the module for: a key cannot mean two things on two screens.
  Replacing a default with the shop's key is a one-line change there.

## Choices made closing the plan audit's gaps (2026-10-22)

The owner directed best-practice resolution of open choices on 2026-10-22
(`docs/review/2026-10-22-pr12-decisions.md`). The renderer gaps the Phase 6 plan audit confirmed were closed
as follows:

- **Price check sends what was typed as a barcode as well as text** when it has no whitespace and fits a
  barcode's 64 characters. The plan's `/^\d{6,}$/` test would miss short barcodes, such as a shop's own
  four-digit codes. `priceCheck` puts the barcode hit first and drops duplicates, so a typed code or name still
  finds its matches. The field reads *Scan a barcode, or type a code or name* (`pos.priceCheckQuery`).
- **A lookup is not an operation.** Barcode, item, customer and price-check lookups never show *Completed.*
  An unknown scan is refused as `ERR_NOT_FOUND`, and an empty result says so (`pos.noItems`,
  `pos.noCustomers`).
- **A misread scan stays in the field, selected**, so the cashier sees what was read and the next scan replaces
  it instead of being appended to it. That holds for a refused lookup too (a scan too long to be a barcode, or a
  price check whose tax code has left the catalogue). The price-check field does the same after every lookup,
  since a cashier scans one item after another there, and a lookup started with the button returns the cursor to
  the field. A refused price check also clears the list, so the previous item's price is not left beside the
  refusal. The plan's `PriceCheckRoute` left its field as typed, so a second scan would have been appended to the
  first.
- **Enter never runs an action other than the one beside the field.** Until this change (and at `98f40a6`), the
  shift screen's void fields sat inside the shift-close form and the cancellation's reason inside the payment
  form. Enter in *Ticket reference to void* closed the shift with the counted-cash field's default of 0, and Enter
  in the payment screen's *Reason* completed the sale the cashier meant to cancel, at the prefilled cash amount.
  Each is now its own form, with its button as the form's submit button, disabled until the button's own
  conditions hold. So Enter in those fields voids or cancels, and before a reason it does nothing. The receipt's
  void fields, where Enter did nothing, became a form too, so a void is keyed the same way on both screens. No
  workflow changes: the fields, buttons and bridge calls are the same, and only the form each field belongs to
  is different.
- **The void and the cancellation keep their own reason, supervisor and PIN**, emptied whenever the screen
  changes. They used to share the sell screen's supervisor approval. A number, PIN and reason a supervisor
  typed for a discount then enabled the void on `F10`, and a scanned ticket reference ending in Enter sent the
  void under that PIN with the discount's reason. The same reason also prefilled the payment screen's
  cancellation and the receipt's void. The sell screen's approval is untouched: it still travels with `sell`.
- **Loading a return (or any non-sale) as the original** shows *Choose an original sale ticket.*
  (`pos.originalSaleRequired`), not the internal-fault message.
- **The receipt heads its line column *Item*** (`pos.item`) and names the cashier by the principal id the
  ticket records, as the plan's receipt does. A friendlier name, such as the employee number, would need a new
  field in the main process's `ReceiptPayload`.
- **There is no currency fallback.** An amount is formatted only once the till reports its currency (the
  catalogue's). A write attempted without one is refused as `ERR_TILL_CATALOGUE_STALE`. In practice the main
  process reports a currency for every signed-in session, so this refusal is defensive only.
- **`app.css` uses the shared design system.** It loads `@dulja/ui`'s Tailwind preset (`@config
  "@dulja/ui/tailwind-preset"`) and `tokens.css`, the same pair the back office loads, and defines no colour or
  font of its own. It keeps its layout rules (flex rows, spacing, the print-only receipt), now written in
  tokens. The plan's "adds nothing of its own" assumed per-route components with utility classes, and this
  build's single `app.tsx` renders plain elements.

## Actions with no shortcut, which the owner's keyboard map would decide

Change quantity, line discount, price override, void a line, start a return, open the drawer (`F10` reaches the
screen, but not the button), clock in and out, print, next sale and switch cashier. Cancelling an unpaid ticket
is reached with `Shift+Tab` and voiding a completed one with `Tab`, and both are finished with `Enter`, as
above.
spec:2254's *"no mouse is required"* holds for all of them through `Tab` and `Enter`/`Space`. Whether the shop's
own keys are faster is the legacy-parity question this baseline leaves open.

## Verification, and what it does not prove

`apps/pos/test/renderer.test.tsx` runs every case in English (LTR) and Arabic (RTL), against the real
main-process handlers over an in-memory SQLite till. It covers selling by keyboard with `F8`, payment and the
receipt, cancellation, both drawer events, resuming an unpaid ticket, a scanned price check and the next scan
replacing it (after a refused lookup too), the cancellation's `Shift+Tab` path, Enter in the cancellation's and
the void's fields running only that action (never completing the sale or closing the shift), a sale's supervisor
approval never reaching a void or a cancellation, the not-found and no-match feedback, the till's own refusal of
a non-sale original, refused PINs and lockout in the till's language, and the honest offline indicator (online,
offline with an unsent count, never pulled, and the real main process's state).

**Not proven:**

- Legacy keyboard parity, and any operator walkthrough. There is no owner material (OD-24).
- The screens in a real Electron window. Plan Step 6's `tests/e2e/pos-rtl-parity.spec.ts` runs the built
  till in Playwright's Chromium, not `pos.exe`. It runs under the desktop's CSP, at its 1280×800 window and
  against the built main-process bundle. In both directions it visits thirteen views: enrol and a refused
  enrolment, sign-in, open shift, sell, the return mode with an original loaded, the open supervisor approval,
  payment, receipt, price check, customer, shift and the closed shift's summary. On each it checks overflow,
  one numbering system, no untranslated string, and the same things and figures in the other language. It
  reads the receipt's column order and a date's digit order, and completes a sale with Enter, F8, Tab and
  Enter. Layout is therefore proven in a real engine for those views, and Electron's own window is not
  (`docs/reports/phase-6.md`, "6B T11 Step 6"). The views it does not visit are listed in the spec's header.
- Windows packaged execution, a physical scanner and a receipt printer.

**The owner can close the gate** by putting screenshots of the legacy sell, payment, price-check and shift-close
screens, an `operator-description.md` and the shop's keyboard map in `docs/owner/od-24/6b/`. The key column above
is then replaced from that material, row by row.
