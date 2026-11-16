import type { PosDatabase } from "./database";
import type { TicketDraft } from "./ticket";
export interface ReceiptItemSnapshot {
  itemId: string;
  unitId: string;
  lotId: string | null;
  code: string;
  nameEn: string;
  nameAr: string | null;
}
/** Owned receipt display facts survive a mirror update or tombstone. */
export function snapshotReceiptItems(
  sqliteDb: PosDatabase,
  draft: TicketDraft,
  originalRef: string | null,
): void {
  const priorText =
    originalRef === null
      ? undefined
      : sqliteDb.raw
          .prepare<[string], { value: string }>("select value from meta where key=?")
          .get(`receipt_items:${originalRef}`)?.value;
  const prior = priorText ? (JSON.parse(priorText) as Record<string, ReceiptItemSnapshot>) : {};
  const values: Record<string, ReceiptItemSnapshot> = {};
  const read = sqliteDb.raw.prepare<
    [string],
    { code: string; name_en: string; name_ar: string | null }
  >("select code,name_en,name_ar from catalogue_item where id=?");
  for (const line of draft.lines) {
    const source = Object.values(prior).find(
      (item) =>
        item.itemId === line.itemId && item.unitId === line.unitId && item.lotId === line.lotId,
    );
    const current = read.get(line.itemId);
    values[String(line.lineNo)] = source ?? {
      itemId: line.itemId,
      unitId: line.unitId,
      lotId: line.lotId,
      code: current?.code ?? line.itemId,
      nameEn: current?.name_en ?? line.itemId,
      nameAr: current?.name_ar ?? null,
    };
  }
  const put = sqliteDb.raw.prepare(
    "insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value",
  );
  put.run(`receipt_items:${draft.clientRef}`, JSON.stringify(values));
  const at = sqliteDb.raw
    .prepare<[], { value: string }>("select value from meta where key='catalogue_pulled_at'")
    .get()?.value;
  if (at) put.run(`catalogue_at:${draft.clientRef}`, at);
}
