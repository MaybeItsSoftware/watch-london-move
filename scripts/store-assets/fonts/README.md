# Vendored faces

sharp rasterises SVG through librsvg, which resolves `font-family` through
fontconfig — against whatever the machine happens to have installed. None of
these are macOS system fonts, so without vendoring them every caption would
silently fall back to Helvetica and the artwork would misrepresent its own
typography. `lib/fonts.mjs` points fontconfig here before sharp loads.

Licensed under the SIL Open Font License 1.1, from
<https://github.com/google/fonts>.

| File | Family |
|---|---|
| `Archivo[wdth,wght].ttf` | Archivo |

To check a family actually resolves rather than falling back:

    FONTCONFIG_FILE=$(node -e "import('./lib/fonts.mjs').then(()=>console.log(process.env.FONTCONFIG_FILE))") fc-match Archivo
