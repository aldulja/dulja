import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

/** The fixture's shape — the same JSON `render.ts` reads and the other two candidates consume. */
export interface InvoiceParty { nameEn: string; nameAr: string; addressEn: string; addressAr: string; registrationId: string }
export interface InvoiceLine { descriptionEn: string; descriptionAr: string; quantity: string; unitPrice: string; amount: string }
export interface Invoice {
  number: string;
  issuedOn: string;
  currency: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  subtotal: string;
  tax: { labelEn: string; labelAr: string; rate: string; amount: string };
  total: string;
  notes: { en: string; ar: string };
}

/**
 * fontkit loads TrueType/OpenType from a **file path** (`fontkit.open`), so the font must exist on
 * disk — a family name means nothing here, unlike candidates A and B. `.ttf` is preferred over `.woff`
 * and `.woff2` because woff2 decoding needs a Brotli decoder fontkit may not have. Resolving by scan
 * rather than by a hard-coded filename keeps this working when @fontsource changes its file naming.
 */
const fontFile = (pkg: string, match: RegExp): string => {
  const dir = join(import.meta.dir, "../../node_modules", pkg, "files");
  const rank = (name: string) => (name.endsWith(".ttf") ? 0 : name.endsWith(".woff") ? 1 : 2);
  const found = readdirSync(dir)
    .filter((name) => match.test(name) && /\.(ttf|woff|woff2)$/.test(name))
    .sort((a, b) => rank(a) - rank(b))[0];
  if (found === undefined) {
    throw new Error(`no usable font file in ${dir} — run \`bun add --cwd spikes/pdf-engine ${pkg}\``);
  }
  return join(dir, found);
};

Font.register({ family: "NotoSansArabic", src: fontFile("@fontsource/noto-sans-arabic", /arabic-400-normal/) });
Font.register({ family: "NotoSans", src: fontFile("@fontsource/noto-sans", /latin-400-normal/) });

// The Arabic face first, the Latin face as the fallback: react-pdf's substitution engine walks the
// stack per code point, which is what keeps `XR-9` legible inside an Arabic sentence. If the installed
// version's types reject the array form, use the string "NotoSansArabic, NotoSans" instead and record
// which form was needed in ADR 0016 — it is a property of the candidate, and the ADR is where
// candidate properties go.
const FONT_STACK = ["NotoSansArabic", "NotoSans"];

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: FONT_STACK },
  heading: { fontSize: 16, marginBottom: 8 },
  meta: { marginBottom: 12 },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 16 },
  row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#888888", paddingVertical: 4 },
  description: { flex: 3 },
  figure: { flex: 1, textAlign: "right" },
  totals: { marginTop: 16 },
});

/**
 * `direction` is set on every container: react-pdf lays a `row` out end-to-start under `rtl`, which is
 * the column-order half of acceptance test 23. `textAlign: "right"` on the figure columns is the
 * physical spelling react-pdf offers — it has no logical `start`/`end` — so under `rtl` the figures
 * still sit against the reader's trailing edge because the row itself is reversed.
 */
export async function renderInvoice(fixture: Invoice, dir: "ltr" | "rtl"): Promise<Buffer> {
  const rtl = dir === "rtl";
  const label = rtl
    ? { title: "فاتورة ضريبية", desc: "الوصف", qty: "الكمية", price: "السعر", amt: "المبلغ" }
    : { title: "Tax invoice", desc: "Description", qty: "Quantity", price: "Unit price", amt: "Amount" };
  const party = (p: InvoiceParty) => (rtl ? p.nameAr : p.nameEn);

  return renderToBuffer(
    <Document>
      <Page size="A4" style={styles.page} debug={false}>
        <View style={{ direction: dir }}>
          <Text style={styles.heading}>{label.title}</Text>
          <Text style={styles.meta}>{`${fixture.number} · ${fixture.issuedOn}`}</Text>

          <View style={[styles.parties, { direction: dir }]}>
            <Text>{party(fixture.seller)}</Text>
            <Text>{party(fixture.buyer)}</Text>
          </View>

          <View style={[styles.row, { direction: dir }]}>
            <Text style={styles.description}>{label.desc}</Text>
            <Text style={styles.figure}>{label.qty}</Text>
            <Text style={styles.figure}>{label.price}</Text>
            <Text style={styles.figure}>{label.amt}</Text>
          </View>

          {fixture.lines.map((line, index) => (
            <View key={String(index)} style={[styles.row, { direction: dir }]}>
              <Text style={styles.description}>{rtl ? line.descriptionAr : line.descriptionEn}</Text>
              <Text style={styles.figure}>{line.quantity}</Text>
              <Text style={styles.figure}>{line.unitPrice}</Text>
              <Text style={styles.figure}>{line.amount}</Text>
            </View>
          ))}

          <View style={[styles.totals, { direction: dir }]}>
            <Text style={styles.figure}>{fixture.subtotal}</Text>
            <Text style={styles.figure}>
              {`${rtl ? fixture.tax.labelAr : fixture.tax.labelEn}: ${fixture.tax.amount}`}
            </Text>
            <Text style={styles.figure}>{`${fixture.total} ${fixture.currency}`}</Text>
            <Text>{rtl ? fixture.notes.ar : fixture.notes.en}</Text>
          </View>
        </View>
      </Page>
    </Document>,
  );
}
