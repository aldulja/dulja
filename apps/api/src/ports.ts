export interface VerifiedToken {
  readonly sub: string;
  readonly aal: "aal1" | "aal2";
}
export type JwtVerifier = (token: string) => Promise<VerifiedToken>;
export interface InvitedUser {
  readonly sub: string;
  readonly email: string;
}
export interface AuthAdmin {
  inviteUser(email: string): Promise<InvitedUser>;
  /** Creates an email-confirmed provider user without an invitation or password disclosure. */
  createUser(email: string): Promise<InvitedUser>;
}
