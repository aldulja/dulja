#!/usr/bin/env bash
# Asserts on the PDFs render-probe.ts wrote inside the runtime image (ci.yml's `image` job). Needs poppler-utils.
# For each entrypoint (api, worker) and language (en, ar): real PDF bytes, every label of that language in the
# extracted text, and — for Arabic — an embedded face that has Arabic glyphs, so a document whose Arabic fell back to
# boxes (no Arabic font in the image) or to an empty page fails here instead of in front of a customer. The faces
# admitted are the image's two with Arabic coverage: fonts-noto-core's Arabic families, and DejaVu Sans, which
# fontconfig-config pulls in as its default font and which Chromium's fallback may pick for Arabic text. The job
# separately asserts the Noto Arabic families are installed (`fc-list :lang=ar`).
set -euo pipefail
dir="${1:?usage: check-pdfs.sh <dir>}"
declare -A labels=(
  [en]="Trial balance|Account|Balance|Cash at bank"
  [ar]="ميزان المراجعة|الحساب|الرصيد|النقد في البنك"
)
fail=0
for entry in api worker; do
  for lang in en ar; do
    pdf="$dir/$entry-$lang.pdf"
    if [ "$(head -c 5 "$pdf")" != "%PDF-" ]; then echo "FAIL $pdf: not a PDF"; fail=1; continue; fi
    # Poppler may emit Arabic in presentation forms; NFKC folds them back to the letters the labels use.
    # Spaces are dropped so a word-boundary choice in extraction cannot decide the result.
    text="$(pdftotext -enc UTF-8 "$pdf" - | python3 -c 'import sys,unicodedata; print(unicodedata.normalize("NFKC", sys.stdin.read()).replace(" ","").replace("\n",""))')"
    IFS='|' read -r -a want <<<"${labels[$lang]}"
    for label in "${want[@]}"; do
      needle="${label// /}"
      if [[ "$text" != *"$needle"* ]]; then echo "FAIL $pdf: label '$label' not in its text"; fail=1; fi
    done
    fonts="$(pdffonts "$pdf")"
    if [ "$lang" = ar ] && ! grep -qiE 'Noto(Sans|Naskh|Kufi)Arabic|DejaVuSans' <<<"$fonts"; then
      echo "FAIL $pdf: no Arabic-capable face embedded"; echo "$fonts"; fail=1
    fi
    echo "checked $pdf ($(wc -c <"$pdf") bytes); fonts: $(tail -n +3 <<<"$fonts" | awk '{print $1}' | sed 's/^[A-Z]*+//' | sort -u | tr '\n' ' ')"
  done
done
exit "$fail"
