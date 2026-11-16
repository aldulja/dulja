# ADR-0006 — Route registry and isolation probes

**Status:** accepted · **Date:** 2026-09-14 · **Slice:** 0B

Production routes are registered once in `ROUTES`. Test-only tenant-isolation probes live outside the API package and are checked bidirectionally against that registry. This keeps Testcontainers out of production code while making missing endpoint coverage a build failure.
