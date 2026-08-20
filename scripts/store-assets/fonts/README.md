# Vendored faces

sharp rasterises SVG through librsvg, which resolves `font-family` through
fontconfig — against whatever the machine happens to have installed. None of
these are macOS system fonts, so without vendoring them every caption would
silently fall back to Helvetica and the artwork would misrepresent its own
typography. `lib/fonts.mjs` points fontconfig here before sharp loads.

All are licensed under the SIL Open Font License 1.1 and taken from
<https://github.com/google/fonts>.

| File | Family | Used by |
|---|---|---|
| `Archivo[wdth,wght].ttf` | Archivo | the shipping L/swiss artwork |
| `Anton-Regular.ttf` | Anton | explorations/type |
| `BebasNeue-Regular.ttf` | Bebas Neue | explorations/type |
| `Figtree[wght].ttf` | Figtree | explorations/type |
| `SpaceGrotesk[wght].ttf` | Space Grotesk | explorations/type |
| `JetBrainsMono[wght].ttf` | JetBrains Mono | explorations/type |
| `Arvo-Regular.ttf`, `Arvo-Bold.ttf` | Arvo | explorations/editorial, arrow, flow |
| `GeistMono[wght].ttf` | Geist Mono | explorations/editorial, arrow, flow |

Only Archivo is needed to build the current listing; the rest are kept so the
parked explorations still render.

To check a family actually resolves rather than falling back:

    FONTCONFIG_FILE=$(node -e "import('./lib/fonts.mjs').then(()=>console.log(process.env.FONTCONFIG_FILE))") fc-match Archivo
