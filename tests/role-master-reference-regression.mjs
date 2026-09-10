import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { isCustomImage2Reference, selectImage2ReferenceForRole } from "../shared/image2-reference.js";

// Execute the actual job builder and anchor-reference filter without starting
// a server, accessing project state, or invoking any model/provider.
const source = fs.readFileSync(new URL("../server/generation.js", import.meta.url), "utf8");
const start = source.indexOf("function buildGenerationJob(");
const end = source.indexOf("export function enqueueGenerationJobs(", start);
assert.ok(start >= 0 && end > start, "production generation functions must be found");
const functions = source.slice(start, end).replaceAll("export function ", "function ");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const anchorPath = "project/final-images/confirmed-body.png";
const context = vm.createContext({
  deps: {
    pageNoForPage: (page) => page.pageNo,
    buildImage2StyleBible: (profile) => profile.testBible,
    buildPrompt: (page) => `Locked content: ${page.title}`,
    promptHash: hash,
    slugify: (text) => text,
    generationStatusText: (status) => status
  },
  isCustomImage2Reference,
  selectImage2ReferenceForRole,
  image2ContentAnchorContractForPage: () => ({ pageId: "P02", assetPath: anchorPath, signature: "confirmed", version: "1" }),
  image2ContentAnchorPromptContract: () => "Confirmed body anchor contract",
  initializeDualStyleAnchors: () => ({}),
  normalizeImage2RepairFeedback: (value) => value,
  finalizeImage2BodyPrompt: (value) => value,
  isImage2CoverPage: (page) => page.masterRole === "cover",
  image2AnchorDependenciesForPage: () => [{ kind: "content-anchor", path: anchorPath, signature: "confirmed" }],
  IMAGE2_VISUAL_CONTRACT_VERSION: "test"
});
vm.runInContext(`${functions}\nglobalThis.buildJob = buildGenerationJob;`, context);

const roles = ["cover", "directory", "data", "content", "process", "conclusion"];
function sixPageProfile(id, custom = false) {
  const base = `workbench/public/image2-style-previews/${id}`;
  const slides = Object.fromEntries(roles.map((role, index) => [role, `${base}/slides/slide-${index + 1}.png`]));
  return {
    id, templateId: id,
    ...(custom ? { referenceBundleId: "uploaded-six-pages" } : {}),
    testBible: { styleId: id, signature: `${id}:masters-v2`, referenceManifest: { slides, montage: `${base}/montage.png` }, referenceAssetPaths: Object.values(slides) }
  };
}
const cases = [
  { label: "existing built-in six-page pack", profile: sixPageProfile("image2-consulting-poster"), layout: true },
  { label: "new built-in six-page pack", profile: sixPageProfile("image2-pop-comic"), layout: true },
  { label: "custom six-page pack", profile: sixPageProfile("image2-reference-upload", true), layout: true },
  {
    label: "style-only single image", layout: false,
    profile: { id: "image2-single-reference", testBible: { referenceManifest: { usage: "style-only", montage: "styles/reference.png", slides: {} }, referenceAssetPaths: ["styles/reference.png"] } }
  },
  {
    label: "custom cover-only reference", layout: false,
    profile: { id: "image2-reference-cover", referenceBundleId: "uploaded-cover", testBible: { referenceManifest: { slides: { cover: "styles/uploaded-cover.png" } }, referenceAssetPaths: ["styles/uploaded-cover.png"] } }
  }
];

let assertions = 0;
for (const item of cases) {
  for (const role of roles.filter((role) => role !== "cover")) {
    const page = { id: "P03", pageNo: "P03", masterRole: role, title: `${role} page` };
    const deck = { styleProfile: item.profile, pages: [page] };
    const job = context.buildJob(page, 0, deck, null, { phase: "full" });
    const expectedLayout = item.layout ? item.profile.testBible.referenceManifest.slides[role] : null;
    const actualPaths = Array.from(job.styleReferencePaths);
    assert.equal(job.referenceLayoutPath, expectedLayout, `${item.label}/${role}: role-specific layout path`);
    assert.deepEqual(actualPaths, [anchorPath, ...(expectedLayout ? [expectedLayout] : [])], `${item.label}/${role}: actual model references after confirmed body anchor`);
    assert.equal(job.referenceRoles[0].role, "strict-style-master", `${item.label}/${role}: body anchor remains authoritative`);
    assert.deepEqual(Array.from(job.referenceRoles.filter((entry) => entry.role === "layout-only"), (entry) => entry.path), expectedLayout ? [expectedLayout] : [], `${item.label}/${role}: only matching role becomes layout-only`);
    assert.ok(!actualPaths.some((path) => path.endsWith("montage.png") || path.endsWith("uploaded-cover.png")), `${item.label}/${role}: overview/cover must not override the body anchor`);

    const anchorJob = context.buildJob(page, 0, deck, null, { phase: "anchors" });
    assert.ok(!Array.from(anchorJob.styleReferencePaths).includes(anchorPath), `${item.label}/${role}: anchor phase remains independent`);
    assert.ok(anchorJob.selectedStyleReferencePaths.every((path) => anchorJob.styleReferencePaths.includes(path)), `${item.label}/${role}: seed references retained before a body anchor exists`);
    assertions += 7;
  }
}
console.log(`PASS role-master-reference-regression: ${cases.length} profile cases, 5 body roles, ${assertions} assertions`);
