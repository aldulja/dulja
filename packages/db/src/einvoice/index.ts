export { EInvoiceError, type EInvoiceErrorCode } from "./errors";
export {
  EINVOICE_SECRET_NAMES,
  credentialsFor,
  readSecret,
  type CompanyEInvoiceSettings,
  type EInvoiceSecretName,
} from "./credentials";
export { REDACTED, redactResponse } from "./redact";
export {
  createHttpTransmitter,
  TransientTransmissionError,
  type HttpTransmitterOptions,
  type RegisteredTransmitter,
  type RemoteCallResult,
} from "./http-transmitter";
export {
  PROFILE_DIR,
  ProfileNotFoundError,
  availableProfileVersions,
  loadProfile,
  profilePath,
} from "./profile";
export {
  SYNTHETIC_PROFILE_CODE,
  createSyntheticTransmitter,
  sha256Hex,
  syntheticCanonicalise,
  syntheticQrPayload,
} from "./synthetic";
export {
  TRANSMITTER_CODES,
  registerDefaultTransmitters,
  registerTransmitter,
  registeredTransmitters,
  resetTransmitters,
  transmitterFor,
  type TransmitterCode,
  type TransmitterRegistration,
} from "./registry";
export { formatVerifyResult, verifyProfile, type VerifyResult } from "./verify";
export {
  admitOperatorSubmit,
  CANCELLABLE_FROM,
  CLAIM_WINDOW_SECONDS,
  POLLABLE_FROM,
  SUBMITTABLE_FROM,
  cancelTransmission,
  companySettings,
  getTransmission,
  listTransmissions,
  pollTransmission,
  recordPending,
  submitTransmission,
  UNADDRESSED_ACKNOWLEDGEMENT_PREFIX,
  type EinvoiceTransmissionRow,
  type ListTransmissionsInput,
} from "./transmission";

export * from "./settings";

export {
  createMyInvoisTransport,
  encodeMyInvoisSubmission,
  myInvoisValidationLink,
  type AuthorityDocumentEncoder,
} from "./myinvois";
