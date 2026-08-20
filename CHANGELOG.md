## [0.3.1](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.3.0...v0.3.1) (2026-08-20)


### Bug Fixes

* **ci:** strip config comments and fail on a bad Vercel deployment ([12ed8cb](https://github.com/MaybeItsSoftware/watch-london-move/commit/12ed8cb7da1dec44df21a61e96bf8040ec020ede))

# [0.3.0](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.2.0...v0.3.0) (2026-08-20)


### Bug Fixes

* **backend:** drop the VOLUME instruction Railway rejects ([34a9066](https://github.com/MaybeItsSoftware/watch-london-move/commit/34a9066226fd73c295b213fbcc5ec547d6e6533d))


### Features

* **backend:** rate-limit the expensive paths and cap connections ([6b67ffa](https://github.com/MaybeItsSoftware/watch-london-move/commit/6b67ffa2206b918ffdd8a6abbf882eb2b48f7263))
* **frontend:** report errors, attribute TfL, and fail visibly ([238ac1b](https://github.com/MaybeItsSoftware/watch-london-move/commit/238ac1b69b4d1f90795fbcd42c2202648108db46))
* **pwa:** add the web app manifest that makes the site installable ([7bc10b7](https://github.com/MaybeItsSoftware/watch-london-move/commit/7bc10b7261f62a1c92f5c426a396f4e5ee95b021))


### Performance Improvements

* **backend:** parse the whole-network bus feed on a worker thread ([4158d48](https://github.com/MaybeItsSoftware/watch-london-move/commit/4158d48bfd64a6a9be26823b54c2b2d735aaecca))
* **frontend:** keep the UI out of the animation frame ([f3bec4b](https://github.com/MaybeItsSoftware/watch-london-move/commit/f3bec4bf86b45cfd61550cf03fb7b570936caa51))
* **frontend:** pace the animation loop to what the device sustains ([85abe90](https://github.com/MaybeItsSoftware/watch-london-move/commit/85abe900367ff5a5877267509a41e899cb7ee748))
* **frontend:** write vehicle poses in place instead of copying the fleet ([df8b2ce](https://github.com/MaybeItsSoftware/watch-london-move/commit/df8b2cefc39960e13f5517f50a0f7e95d8a1b090))

# [0.2.0](https://github.com/MaybeItsAdam/watch-london-move/compare/v0.1.0...v0.2.0) (2026-08-09)


### Features

* **map:** draw vehicles as 3D models under a day/night basemap ([8c15bc3](https://github.com/MaybeItsAdam/watch-london-move/commit/8c15bc303876a47b73920775af7791fd978308ae))
* **pwa:** cache the web app and its data in a service worker ([0a844e9](https://github.com/MaybeItsAdam/watch-london-move/commit/0a844e906b0e3e0dd82bfccf93dd80d21c0df202))
* **vehicles:** stream upcoming stops and snap motion to route geometry ([c5f1f32](https://github.com/MaybeItsAdam/watch-london-move/commit/c5f1f32e854459f4a7afe9e67323f929af6acf6c))


### Performance Improvements

* **backend:** compress HTTP responses and revalidate /routes with an ETag ([f01322c](https://github.com/MaybeItsAdam/watch-london-move/commit/f01322cfdd5dda853ecaef16983a28fba44ae3d6))
* **frontend:** ship route geometry and stops in the build ([afeb94c](https://github.com/MaybeItsAdam/watch-london-move/commit/afeb94c33e1c9277bced029cbc2fac471d80d9e9))
