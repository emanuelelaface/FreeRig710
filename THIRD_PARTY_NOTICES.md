# Third-party notices

The FreeRig710 source in this repository is licensed under the MIT License. The following external software/data are used by the FT8 implementation and keep their own licenses.

## ft8js 0.0.2 / ft8_lib

`frontend/ft8-worker.js` loads the pinned decoder module from jsDelivr:

```text
https://cdn.jsdelivr.net/npm/ft8js@0.0.2/wasm/decode.js
```

- package: `ft8js` 0.0.2
- upstream: `e04/ft8js`
- package license: MIT
- codec: `kgoba/ft8_lib`
- `ft8_lib` license: MIT, Copyright (c) 2018 Kārlis Goba

The dependency is not vendored in this repository.

## @e04/ft8ts 0.0.14

`frontend/ft8-worker.js` loads the pinned transmit encoder from jsDelivr:

```text
https://cdn.jsdelivr.net/npm/@e04/ft8ts@0.0.14/+esm
```

The source comments identify this package as a TypeScript port of the WSJT-X FT8 implementation and as **GPL-3.0 licensed**. It is loaded at runtime and is not vendored into this MIT source tree. Review the upstream license before redistributing a bundled/offline copy.

## GeoNames data

`frontend/ft8-geo.js` contains a compact derivative geographic index built from GeoNames-compatible data.

GeoNames geographic data is licensed under **Creative Commons Attribution 4.0 (CC BY 4.0)**.

Attribution: **GeoNames — https://www.geonames.org/**

The generator uses the GeoNames `cities500`, `admin1CodesASCII` and `countryInfo` formats. The generated runtime index stores compact country/continent, admin-region and representative populated-place labels associated with Maidenhead-4 cells. It is intentionally not an exact station-location database.

License: <https://creativecommons.org/licenses/by/4.0/>

GeoNames export documentation: <https://download.geonames.org/export/dump/readme.txt>
