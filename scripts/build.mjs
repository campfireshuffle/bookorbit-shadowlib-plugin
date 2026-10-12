import { build } from "esbuild";
await build({ entryPoints: ["src/index.ts"], outfile: "dist/index.mjs", bundle: true, format: "esm", platform: "node", target: "node22", minify: false, legalComments: "eof", metafile: false });
