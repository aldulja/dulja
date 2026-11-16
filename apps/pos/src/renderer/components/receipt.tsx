import {
  formatMoney,
  formatQuantity,
  formatTimestamp,
  type Locale,
  type TranslationKey,
} from "@dulja/i18n";
import type { ReceiptPayload } from "../../main/receipt";
export function Receipt({
  receipt,
  locale,
  t,
}: {
  receipt: ReceiptPayload;
  locale: Locale;
  t: (key: TranslationKey) => string;
}) {
  const money = (amount: string) => formatMoney({ amount, currency: receipt.currency }, { locale });
  return (
    <article id="receipt" aria-label={t("pos.receipt")}>
      <h2>{t("pos.receipt")}</h2>
      <p>{receipt.documentNumber ?? t("pos.numberPending")}</p>
      <dl>
        <dt>{t("pos.ticketRef")}</dt>
        <dd>{receipt.clientRef}</dd>
        <dt>{t("pos.date")}</dt>
        <dd>{formatTimestamp(receipt.soldAt, { locale })}</dd>
        {/* The cashier the ticket records (6B T11's receipt): the principal id is what the till holds for it. */}
        <dt>{t("pos.cashier")}</dt>
        <dd>{receipt.cashierPrincipalId}</dd>
        <dt>{t("pos.customer")}</dt>
        <dd>{receipt.customerName ?? t("pos.walkIn")}</dd>
      </dl>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("pos.item")}</th>
            <th scope="col">{t("pos.quantity")}</th>
            <th scope="col">{t("pos.unitPrice")}</th>
            <th scope="col">{t("pos.discount")}</th>
            <th scope="col">{t("pos.total")}</th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((line) => (
            <tr key={line.lineNo}>
              <td>
                {locale === "ar" ? (line.nameAr ?? line.nameEn) : line.nameEn}
                <small>{line.code}</small>
              </td>
              <td>{formatQuantity(line.quantity, { locale })}</td>
              <td>{money(line.unitPrice)}</td>
              <td>{money(line.discount)}</td>
              <td>{money(line.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl>
        {(["netTotal", "taxTotal", "total", "rounding", "change"] as const).map((key) => (
          <div key={key}>
            <dt>{t(`pos.${key}`)}</dt>
            <dd>{money(receipt[key])}</dd>
          </div>
        ))}
      </dl>
      <ul>
        {/* Settled to the customer's account, so there is no tender to list: the receipt names where it went. */}
        {receipt.onAccount && (
          <li>
            {t(receipt.kind === "return" ? "pos.refundedToAccount" : "pos.chargedToAccount")}:{" "}
            {money(receipt.total)}
          </li>
        )}
        {receipt.tenders.map((payment, index) => (
          <li key={index}>
            {t(`pos.${payment.method}` as TranslationKey)}: {money(payment.amount)}{" "}
            {payment.reference}
          </li>
        ))}
      </ul>
      <p>
        {t("pos.catalogueRevision")}: {receipt.catalogueRevision}
      </p>
      <p>
        {t("pos.catalogueAt")}:{" "}
        {receipt.catalogueAt ? formatTimestamp(receipt.catalogueAt, { locale }) : t("pos.never")}
      </p>
    </article>
  );
}
