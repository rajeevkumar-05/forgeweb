// Compatibility entrypoint; runtime verification is domain-independent.
process.argv = [process.argv[0], process.argv[1], 'scripts/runtime-verification/recipe.json', process.argv[2] ?? 'new', process.argv[3] ?? ''];
await import('./generated-application-runtime-smoke.ts');
export {};
