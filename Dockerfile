# Railway builds this file automatically when it exists (it takes priority over nixpacks.toml / Railpack).
# tesseract-ocr reads scanned pages so their text can be published as real HTML (SEO).
# poppler-utils provides "pdftoppm", which turns every PDF page into an image so it can be blurred on the server.
# qpdf + ghostscript shrink every PDF without losing quality, and ghostscript / poppler bring a PDF over the storage limit down to it (reduceService.js).
# libreoffice (writer + calc) converts Word / Excel / text files to PDF so they are shown exactly as uploaded.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ghostscript qpdf tesseract-ocr tesseract-ocr-eng ca-certificates \
    libreoffice-writer libreoffice-calc fonts-liberation fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh","-c","node --max-old-space-size=${NODE_HEAP_MB:-380} backend/server.js"]
