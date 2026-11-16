export type PosBridge = NonNullable<Window["dulja"]["pos"]>;
export interface PosStatus {
  online: boolean;
  lastPullAt: string | null;
  lastPushAt: string | null;
  catalogueRevision: string;
  pendingOutbox: number;
  lastError: string | null;
  enrolled: boolean;
  signedIn: { principalId: string; branchId: string } | null;
  shiftId: string | null;
  currency: string | null;
  roundingIncrement: string | null;
  catalogueAt: string | null;
  openTicket?: { clientRef: string; total: string; returnsClientRef?: string | null } | null;
  /** Other cashiers' unfinished tickets on the open shift (POS-04). */
  unfinishedTickets?: { clientRef: string; total: string; cashierPrincipalId: string }[];
  /** The open shift's float and local tender totals, for the close's review (UI-02). */
  shiftTotals?: { openingFloat: string; tickets: number; byMethod: Record<string, string> } | null;
}
export type Item = import("../../main/pricing").TillItem;
export interface Customer {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string | null;
  phone: string | null;
  pending: boolean;
  creditLimit: string | null;
}
export interface BasketLine {
  item: Item;
  quantity: string;
  priceOverride: string;
  discount: string;
  unitId?: string;
  lotId?: string | null;
}
