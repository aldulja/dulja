import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readCorpus, type LegacyCorpus } from "../../src/drivers/fixture";

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

/** Reads a committed corpus directory (default `base`) into the shape FixtureLegacyDriver takes. Synchronous on
 *  purpose: it runs inside a test body, and an await here would buy nothing. */
export function loadCorpus(name = "base"): LegacyCorpus {
  return readCorpus(join(CORPUS_ROOT, name));
}
