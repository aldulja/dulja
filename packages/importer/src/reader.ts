import type { LegacyPredicate } from "./legacy/predicate";
import { unreadable, type LegacyDriver } from "./legacy/types";

/**
 * Contracts §4.13.1, verbatim. 9B consumes this and never redefines it — in particular it calls `read` with a
 * `LegacyPredicate` and never with SQL text. The interface has no catalogue accessor, deliberately: everything
 * above it is a report, and a report that could ask for a column list could also ask for anything else.
 */
export interface LegacyReader {
  readonly firebirdVersion: string;
  tables(): Promise<string[]>;
  count(table: string): Promise<number>;
  dateRange(table: string, column: string): Promise<{ min: string | null; max: string | null }>;
  read<T>(
    table: string,
    opts: { columns: string[]; where?: LegacyPredicate; batch: number },
  ): AsyncIterable<T[]>;
}

class DriverReader implements LegacyReader {
  readonly firebirdVersion: string;
  private readonly driver: LegacyDriver;

  constructor(firebirdVersion: string, driver: LegacyDriver) {
    this.firebirdVersion = firebirdVersion;
    this.driver = driver;
  }

  tables(): Promise<string[]> {
    return this.driver.tables();
  }

  count(table: string): Promise<number> {
    return this.driver.count(table);
  }

  dateRange(table: string, column: string): Promise<{ min: string | null; max: string | null }> {
    return this.driver.minMax(table, column);
  }

  read<T>(
    table: string,
    opts: { columns: string[]; where?: LegacyPredicate; batch: number },
  ): AsyncIterable<T[]> {
    const driver = this.driver;
    const spec =
      opts.where === undefined
        ? { table, columns: opts.columns }
        : { table, columns: opts.columns, where: opts.where };
    return {
      async *[Symbol.asyncIterator]() {
        // `T` is the caller's local row shape (§4.13.1's closing note: no per-table row interface); every value
        // in it is a `LegacyScalar`, because the renderer casts every non-text column to varchar.
        for await (const rows of driver.cursor(spec, opts.batch)) yield rows as unknown as T[];
      },
    };
  }
}

/**
 * `firebirdVersion` is a required non-empty string in §4.13.1, so a reader cannot exist without one. Firebird
 * 2.1 and later answer `rdb$get_context('SYSTEM','ENGINE_VERSION')`; an older engine raises, and then the
 * version is the owner's `--firebird-version` and nothing else. Contracts hazard 3: it is never inferred.
 */
export async function createReader(
  driver: LegacyDriver,
  declaredVersion?: string,
): Promise<LegacyReader> {
  const declared = declaredVersion?.trim();
  const version = declared || (await driver.engineVersion())?.trim();
  if (!version)
    throw unreadable("the engine did not report a version; supply one (OD-17, ADR 0081)");
  return new DriverReader(version, driver);
}
