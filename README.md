# SpaxButchery-Analytics

v2.6 — Local analytics PWA for SpaxButchery: M-Pesa/PDF imports (embedded text +
Tesseract OCR with photo-page auto-enhancement), daily-ledger sheet photo
capture, masked-contact resolver with structured handwriting-review table,
dedup guard, SMS/WhatsApp.

**Deep handwriting OCR (beta):** photographed contact notebooks defeat classical
OCR on digits (loopy joined handwriting). The resolver can optionally run a
deep-learning pass (PP-OCRv4 via onnxruntime-web, lazy-loaded from CDN on first
use, ~15 MB once, cached for offline afterwards). Per row it builds a
"composite strip" (ink runs re-placed with uniform gaps), reads both the
composite and the raw photo strip, and votes on phone candidates across the
variants. The review table shows the **actual ink strip** of each row next to
the prefilled phone so digit fixes are one glance, plus "deep read" and
mask-match suggestion chips. Toggle in the review dialog; persists in
`spaxDeepOcr`. Degrades gracefully when offline/CDN-blocked (standard OCR only).
