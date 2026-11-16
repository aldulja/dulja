# Pinned by digest, not by the floating `1-slim` tag, so two builds of the same commit are the same image.
# sha256:cb3b… is the OCI image index (both arches) that oven/bun:1-slim resolved to on 2026-09-05, read from
# https://hub.docker.com/v2/repositories/oven/bun/tags/1-slim. Renovate keeps it current: infra/renovate.json
# sets pinDigests for the docker datasource, so a rebased digest arrives as a reviewable pull request.
FROM oven/bun:1-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/sync/package.json packages/sync/package.json
COPY packages/importer/package.json packages/importer/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/edge/package.json apps/edge/package.json
# Manifests only. A frozen install needs every workspace manifest to resolve the graph, but none of
# these apps ship in this image: the back office is a browser bundle Electron serves from its own
# build output, and desktop/POS are Electron applications. The runtime stage below copies no source
# or node_modules for these applications.
COPY apps/backoffice/package.json apps/backoffice/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/pos/package.json apps/pos/package.json
COPY tests/package.json tests/package.json
COPY infra/package.json infra/package.json
# --production drops every workspace's devDependencies. The runtime stage serves apps/api and
# apps/worker only, and every package their module graph imports at run time is a `dependencies` entry
# of the importing workspace: infra/test/dockerfile.test.ts walks that graph from infra/entrypoint.sh and
# asserts it. Until 2026-10-06 it did not hold — `playwright`, the API's ADR 0016 print engine, was a
# devDependency and the API could not load in this image; both entrypoints were then loaded in an image
# built from this file. Playwright installs as a library only: it has no install script and Bun runs none
# outside trustedDependencies, so no browser is downloaded: the runtime stage installs Debian's chromium and names it
# in CHROMIUM_EXECUTABLE_PATH. Without --production the image carries workerd (131M),
# @cloudflare/workerd-linux-64 (126M), turbo, miniflare, rolldown, sharp, storybook and
# electron-winstaller into production: 2.87GB against 775MB with it.
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Printing (ADR 0016, OD-20). Both entrypoints render PDFs through Playwright's Chromium — apps/api's documents and
# payslips, apps/worker's reports — and Playwright installs here as a library with no browser (above). Debian's
# `chromium` is the browser; `fonts-noto-core` carries Noto Sans/Serif and the Arabic faces (Noto Naskh Arabic,
# Noto Sans Arabic, Noto Kufi Arabic), without which an RTL document prints as empty boxes; `fontconfig` builds the
# font cache at install time, so the first render does not scan /usr/share/fonts, and gives `fc-list` to ci.yml's
# `image` job, which renders an English and an Arabic PDF inside this image. --no-install-recommends keeps
# chromium's recommended extras (fonts-liberation, its desktop integration) out. One layer, lists removed in it.
# Runs as root, before `USER bun` below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-noto-core fontconfig \
 && rm -rf /var/lib/apt/lists/*
# Both engines read this name (§3.11; apps/edge/src/container-env.ts passes it to both containers too), so the image
# prints without the deployment binding it. The image runs Chromium as the non-root `bun` user and adds no sandbox
# switch of its own; whether Chromium's sandbox is on is the engines' launch option and an open owner decision —
# docs/runbooks/deploy.md, "Runtime image", records what runs today and what turning it on needs from the runtime.
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock ./
COPY tsconfig.base.json ./
# Source is enumerated, not copied wholesale. `COPY packages` put packages/db/migrations,
# packages/db/provision/roles.sql and packages/db/seed/my into a serving image, and
# apps/edge/src/container-env.ts withholds DATABASE_URL_MIGRATOR from that container precisely so a serving
# process cannot run DDL (§3.11, SAH-053): shipping the DDL and the role map there hands whoever reaches the
# filesystem what the withheld credential was protecting. It also carried packages/ui, which neither entrypoint
# imports. What is left is the transitive import graph of the two entrypoints — @dulja/db, @dulja/domain,
# @dulja/contracts, @dulja/sync, since Phase 7A @dulja/i18n (the worker's report formatters, 0E's numeral and
# date policy) and since 9B @dulja/importer (the worker's cut-over load) — plus the few files that graph reads from
# outside a src tree, each named below, and nothing else (infra/test/dockerfile.test.ts walks that graph from infra/entrypoint.sh and checks
# both: every file it loads or reads is copied to the path it is read from). packages/db/src still contains the seed
# CLI's code, but none of its inputs: with no migrations, no pack and no migrator URL it has nothing to run.
COPY packages/contracts/package.json packages/contracts/package.json
# `packages/contracts/src/index.ts` re-exports ../permissions, so the permission catalogue is not optional.
COPY packages/contracts/permissions.ts packages/contracts/permissions.ts
COPY packages/contracts/src packages/contracts/src
COPY packages/db/package.json packages/db/package.json
COPY packages/db/src packages/db/src
# The e-invoice transmitter profiles (ADR 0052). Both entrypoints call registerDefaultTransmitters at boot, which in
# dev and staging reads this directory (`src/einvoice/profile.ts`'s PROFILE_DIR); without it staging has no
# synthetic transmitter. It is data, not DDL or a seed pack, and deliberately lives outside packages/db/seed.
COPY packages/db/einvoice-profiles packages/db/einvoice-profiles
COPY packages/domain/package.json packages/domain/package.json
COPY packages/domain/src packages/domain/src
# 8B's payroll calculator lives beside src (spec:2366 — packages/domain/src may not import it): apps/api/src/problem.ts
# and the payroll services import `@dulja/domain/payroll`, and validate.ts reads its rate-table schema at module load,
# so without the directory neither entrypoint loads. Code and a JSON Schema — no rate table, no seed.
COPY packages/domain/payroll packages/domain/payroll
COPY packages/sync/package.json packages/sync/package.json
COPY packages/sync/src packages/sync/src
# apps/worker/src/reports/formatters.ts imports @dulja/i18n's formatters (7A Task 10), and the package index loads
# `src/i18n.ts`, which imports both catalogues as `../catalogues/<lang>.json` at module load, so the worker does
# not start without them. Translation catalogues are UI strings, not DDL or a seed pack.
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/i18n/src packages/i18n/src
COPY packages/i18n/catalogues packages/i18n/catalogues
# packages/domain/src imports these JSON Schemas as `../../<name>.schema.json` at module load — posting/evaluate.ts
# the first two, tax/einvoice.ts and tax/pack-schema.ts one each, reports/validate.ts the report-definition format
# (7A, ADR 0065) — so without them neither entrypoint loads at all.
COPY packages/domain/document-type-seed.schema.json packages/domain/document-type-seed.schema.json
COPY packages/domain/posting-policy.schema.json packages/domain/posting-policy.schema.json
COPY packages/domain/einvoice-profile.schema.json packages/domain/einvoice-profile.schema.json
COPY packages/domain/tax-pack.schema.json packages/domain/tax-pack.schema.json
COPY packages/domain/report-definition.schema.json packages/domain/report-definition.schema.json
# 9B — the worker's admin.import.run handler runs @dulja/importer's runLoad (contracts round 20 C10). Its `odbc`
# dependency installs without its native binding (Bun runs no install script outside trustedDependencies), and
# `connectOdbc` imports it lazily, so both entrypoints load; reading a live Firebird source from this image needs the
# binding built and the Firebird ODBC driver installed, which is OD-17's deployment work.
COPY packages/importer/package.json packages/importer/package.json
COPY packages/importer/src packages/importer/src
COPY apps/api/package.json apps/api/package.json
COPY apps/api/src apps/api/src
COPY apps/worker/package.json apps/worker/package.json
COPY apps/worker/src apps/worker/src
# Bun installs workspace dependencies beside each workspace manifest. Preserve those links in the runtime stage;
# copying only the root node_modules would omit both external dependencies and the @dulja workspace links.
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=deps /app/packages/sync/node_modules ./packages/sync/node_modules
COPY --from=deps /app/packages/i18n/node_modules ./packages/i18n/node_modules
COPY --from=deps /app/packages/importer/node_modules ./packages/importer/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY infra/entrypoint.sh /usr/local/bin/dulja-entrypoint
RUN chmod +x /usr/local/bin/dulja-entrypoint \
 && chown -R bun:bun /app
USER bun
EXPOSE 8080
ENV DULJA_ENTRYPOINT=api
ENTRYPOINT ["/usr/local/bin/dulja-entrypoint"]
