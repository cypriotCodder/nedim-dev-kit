/**
 * Architectural boundaries. ADAPT the paths to the project's real folders.
 * The rules here must match the "Architecture" section of CLAUDE.md.
 * Run: npx depcruise src --config .dependency-cruiser.cjs
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make agent edits ripple unpredictably.",
      from: {},
      to: { circular: true },
    },
    {
      name: "entrypoints-dont-touch-db",
      severity: "error",
      comment: "Routes/pages must go through features, never straight to the database layer.",
      from: { path: "^src/(app|routes|pages)/" },
      to: { path: "^src/db/" },
    },
    {
      name: "lower-layers-dont-import-upper",
      severity: "error",
      comment: "lib and db are foundations; they never import features or entrypoints.",
      from: { path: "^src/(lib|db)/" },
      to: { path: "^src/(features|app|routes|pages)/" },
    },
    {
      name: "features-use-public-api",
      severity: "error",
      comment: "Import another feature only via its index.ts.",
      from: { path: "^src/features/([^/]+)/" },
      to: {
        path: "^src/features/([^/]+)/.+",
        pathNot: ["^src/features/$1/", "^src/features/[^/]+/index\\.(ts|tsx)$"],
      },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Dead files confuse agents. Delete or wire them up.",
      from: {
        orphan: true,
        pathNot: ["\\.d\\.ts$", "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$", "\\.(test|spec)\\.(ts|tsx)$", "^src/app/", "^src/routes/", "^src/pages/"],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
