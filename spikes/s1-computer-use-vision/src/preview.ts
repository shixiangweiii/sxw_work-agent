/**
 * 不花钱：把三种场景各渲染一张到 raw/preview/，用来人工复核夹具长什么样。
 *   npx tsx spikes/s1-computer-use-vision/src/preview.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAW_DIR, prng, randomCode } from "./harness.js";
import { appScene, codeScene, legibilityScene, render, specOf } from "./scenes.js";

const out = join(RAW_DIR, "preview");
mkdirSync(out, { recursive: true });

const app = appScene(prng(42));
const code = codeScene(prng(7), randomCode(prng(7), [4, 4]));
const leg = legibilityScene(prng(9));
const [a, c, l] = render([specOf(app, 1280, 800), specOf(code, 1280, 800), specOf(leg, 1280, 800)]);
writeFileSync(join(out, "app-1280.png"), a!);
writeFileSync(join(out, "code-1280.png"), c!);
writeFileSync(join(out, "legibility-1280.png"), l!);
for (const t of app.targets) console.log(t.id, t.category, t.desc, JSON.stringify(t.box));
