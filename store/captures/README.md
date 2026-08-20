# Real captures

Drop real screenshots of the running app here, named for the scene they belong
to, and `npm run store` uses them instead of the seeded stand-in:

    01-fleet.png       the whole fleet at city scale
    02-modes.png       mid zoom, several modes visible
    03-daylight.png    the day basemap
    04-close.png       street zoom, 3D vehicle models

Each is cover-cropped to fill its frame, so anything roughly portrait works —
capture at the largest size you can and let the build resize down. The build
prints which source it used; if it says SEEDED STAND-IN, the artwork is not
shippable.
