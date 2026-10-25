// TypeScript 7 requires declarations for side-effect imports of non-code
// assets; Studio's entry imports ./styles.css for the esbuild bundle.
declare module "*.css";
