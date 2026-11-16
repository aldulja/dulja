#let data = json(sys.inputs.fixture)
#let dir = sys.inputs.dir            // "ltr" or "rtl"
#set text(font: ("Noto Sans Arabic", "Noto Sans"), size: 10pt, dir: if dir == "rtl" { rtl } else { ltr })
#set page(paper: "a4", margin: 2cm)

#let nm(p) = if dir == "rtl" { p.nameAr } else { p.nameEn }
#let ln(l) = if dir == "rtl" { l.descriptionAr } else { l.descriptionEn }

= #if dir == "rtl" [فاتورة ضريبية] else [Tax invoice]
#data.number · #data.issuedOn

#grid(columns: (1fr, 1fr), nm(data.seller), nm(data.buyer))

#table(
  columns: (3fr, 1fr, 1fr, 1fr),
  align: (start, end, end, end),
  [#if dir == "rtl" [الوصف] else [Description]],
  [#if dir == "rtl" [الكمية] else [Quantity]],
  [#if dir == "rtl" [السعر] else [Unit price]],
  [#if dir == "rtl" [المبلغ] else [Amount]],
  ..data.lines.map(l => (ln(l), l.quantity, l.unitPrice, l.amount)).flatten(),
)

#align(end)[
  #data.subtotal \
  #if dir == "rtl" { data.tax.labelAr } else { data.tax.labelEn }: #data.tax.amount \
  *#data.total #data.currency*
]
