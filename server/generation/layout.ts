import type { GeneratedFile } from "../domain.ts";

export type LayoutMetadata = { readonly profile: "forgeweb-generated-v1"; readonly approvedPlanId: string };
export type LayoutCompatibility = "managed" | "approved-generated" | "unsupported";

export function layoutCompatibility(files: readonly GeneratedFile[], layout?: LayoutMetadata): LayoutCompatibility {
  if (layout) return layout.profile === "forgeweb-generated-v1" && Boolean(layout.approvedPlanId) ? "approved-generated" : "unsupported";
  const paths = new Set(files.map((file) => file.path));
  const current = ["package.json", "frontend/src/App.tsx", "frontend/src/main.tsx", "backend/src/index.ts", "backend/src/api/contracts.ts", "backend/src/security/access-control.ts"];
  const legacy = ["README.md", "package.json", "tests/acceptance.test.ts", "src/domain/model.ts", "src/security/access-control.ts", "src/api/contracts.ts"];
  return current.every((path) => paths.has(path)) || (paths.size === legacy.length && legacy.every((path) => paths.has(path))) ? "managed" : "unsupported";
}
