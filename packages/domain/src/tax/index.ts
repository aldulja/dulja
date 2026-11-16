export {
  producesNoTax,
  TaxError,
  taxEngine,
  type TaxCodeDef,
  type TaxEngine,
  type TaxLineInput,
  type TaxLineResult,
  type TaxRegime,
} from "./engine";
export { canonicalJson } from "./canonical";
export { contradictsSide, declaredSideOf, taxSideOf, type TaxSide } from "./side";
// jurisdiction.ts and malaysia.ts are added by Task 6.
export {
  buildReturnFrom,
  validateReturnAgainst,
  type JurisdictionPack,
  type RegimeDefinition,
  type ReturnBox,
  type ReturnBoxDef,
  type TaxTransactionRow,
} from "./jurisdiction";
export { MALAYSIA_REGIMES, malaysiaPack, SYNTH_MY_V1 } from "./malaysia";

export { validateTaxPack, type TaxPackValidation } from "./pack-schema";

export * from "./einvoice";
