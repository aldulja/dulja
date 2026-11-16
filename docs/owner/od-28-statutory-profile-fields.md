# OD-28 — the statutory-profile field list

**Decision needed from the owner's accountant, not from the build team.**

spec:2077 says the profile carries "the inputs the PCB/MTD method needs (marital status,
spouse-working flag, child relief count, …)" and that "the field list is verified against LHDN's
current publication, never invented here". The ellipsis is what is open.

**What we shipped without an answer** (8A Task 5, migration `0082`, 2026-11-07, under the owner's
"implement phase 8 entirely" direction, which builds the plan's default) —
`app.employee_statutory_profile` with `marital_status`, `spouse_working`, `child_relief_count`,
`residency_category` and `extra jsonb`. The table is effective-dated (a change is a new row and the
previous row is closed the day before; ADR 0072), gated by the RESTRICTIVE `compensation_gate`
policy on `hr.compensation.read`, and refuses a principal writing their own profile
(`ERR_HR_SELF_PAY`). It is read and written through
`GET|POST /v1/companies/{companyId}/employees/{employeeId}/statutory-profiles`.

**What we need** — for each additional input the current LHDN publication requires: its name, its
type (text, whole number, yes/no, date), whether it is required, and the publication and date it
was read from. That last part is not paperwork: `statutory_rate_table.source` records the same
three facts for every rate table (§4.12.3), and a profile field with no source is the shape
LEGACY-078 describes.

**What changes when it arrives** — one migration in 8B's range promotes the confirmed fields from
`extra` to typed columns and backfills them; the payroll run starts refusing a NULL in a required
field, naming the employee (`ERR_PAYROLL_INPUT_MISSING`, spec:2105 LEGACY-011). Until then a required
field simply is not declared anywhere, and no calculation depends on one.

**No rate, threshold, ceiling or formula belongs in this answer.** Those arrive separately as
`packages/db/seed/my/statutory/<scheme>/vN.json` under OD-23.

**Verify** — `bun run --cwd packages/db test -- test/hr/statutory-profile.test.ts` passes, and this
file is referenced from the pull request that carries 8A Task 5.
