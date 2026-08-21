## [0.5.3](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.5.2...v0.5.3) (2026-08-21)


### Bug Fixes

* **backend:** let smoke.js pass against the default rate limit and auth gate ([611386c](https://github.com/MaybeItsSoftware/watch-london-move/commit/611386cbc852712ec61cf8af28276017de6f46ab))
* **frontend:** point the shipped clients at the custom backend domain ([236e6e1](https://github.com/MaybeItsSoftware/watch-london-move/commit/236e6e1bc924b9f2830623ef3a40612ac71384b8))

## [0.5.2](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.5.1...v0.5.2) (2026-08-21)


### Bug Fixes

* **backend:** judge URA row drops by rate, not by presence ([ba939e2](https://github.com/MaybeItsSoftware/watch-london-move/commit/ba939e2314c272d61bd28b216e57d2d417345cbf))

## [0.5.1](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.5.0...v0.5.1) (2026-08-21)


### Bug Fixes

* **backend:** measure URA clock skew at fetch time, not at read time ([5e9a58f](https://github.com/MaybeItsSoftware/watch-london-move/commit/5e9a58f8969135260a7c571335f56d52545f0312))

# [0.5.0](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.4.0...v0.5.0) (2026-08-21)


### Bug Fixes

* **backend:** keep Tramlink out of the URA bus feed ([5e8d47a](https://github.com/MaybeItsSoftware/watch-london-move/commit/5e8d47a527c1df904c4d5741bb10b64c09fbca4b))


### Features

* **backend:** read bus arrivals from TfL's URA interface ([a681e45](https://github.com/MaybeItsSoftware/watch-london-move/commit/a681e452add0454705ff66a3d934071efb618f66))

# [0.4.0](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.3.4...v0.4.0) (2026-08-20)


### Bug Fixes

* **ci:** drop the Vercel inspect poll that never worked ([0e9226d](https://github.com/MaybeItsSoftware/watch-london-move/commit/0e9226dfa509da17c52a8b26a27f7b37a2ba81d6))


### Features

* **icons:** replace the roundel with the streak mark ([5b83b63](https://github.com/MaybeItsSoftware/watch-london-move/commit/5b83b63b6d311c8fa76c86aad8df19479ec6710c)), closes [#0b0f1a](https://github.com/MaybeItsSoftware/watch-london-move/issues/0b0f1a) [#000f9f](https://github.com/MaybeItsSoftware/watch-london-move/issues/000f9f) [#0b0f1a](https://github.com/MaybeItsSoftware/watch-london-move/issues/0b0f1a)

## [0.3.4](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.3.3...v0.3.4) (2026-08-20)


### Bug Fixes

* **ci:** verify the deploy landed instead of parsing a status line ([75288df](https://github.com/MaybeItsSoftware/watch-london-move/commit/75288df1f358ba472f19b85190529b927d0b3fbe))

## [0.3.3](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.3.2...v0.3.3) (2026-08-20)


### Performance Improvements

* **backend:** stop polling for nobody, and stream the feed ([98ed7cd](https://github.com/MaybeItsSoftware/watch-london-move/commit/98ed7cd50fb0db6e21dfdbe42b9f45c6c77b1f20))

## [0.3.2](https://github.com/MaybeItsSoftware/watch-london-move/compare/v0.3.1...v0.3.2) (2026-08-20)


### Bug Fixes

* **ci:** correct the Vercel deployment state check ([a2172b1](https://github.com/MaybeItsSoftware/watch-london-move/commit/a2172b13926e273019918b1efea9951662056c07))

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
