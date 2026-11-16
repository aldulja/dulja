# `seed/my/statutory` — statutory schemes, pay components and rate tables

**`schemes.json`** and **`pay-components.json`** ship now. They carry names, kinds and codes and
**no number of any kind**.

**`<SCHEME>/vN.json`** — the rate tables — **do not exist yet**, and the four directories beside this
file (`EPF/`, `SOCSO/`, `EIS/`, `PCB/`) are empty on purpose, pending **OD-23**. spec:2080: _"This
document states no rate, threshold, ceiling or formula."_ A rate table enters this repository only when
OD-23 delivers it: the current published tables with, per `packages/domain/payroll/rate-table.schema.json`,
a `source` naming the authority, the publication, its URL and the date it was retrieved, and a
`verification` block naming the accountant who signed it off. The seed pull request is the reviewed diff
SAH-078 asks for.

**`pay_component_scheme` has no rows here either.** "Basic salary is subject to EPF" is a statutory
applicability claim, and this repository makes none. Those rows arrive in the same pull request as the
tables.

**Loading never verifies.** The seed inserts every table unverified, under the system principal; a
different, human principal verifies it through the API (spec:2080, ADR 0073).

Every test in the repository runs on the clearly synthetic `SYNTH` table (`SYNTH_RATE_TABLE_V1` in
`packages/db/test/fixtures.ts`), whose `source.authority` is the literal `"Dulja test fixture"`. The
loader refuses a file with that authority outside `APP_ENV=dev`.
