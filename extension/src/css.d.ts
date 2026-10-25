// TypeScript 7 requires declarations for side-effect imports of non-code
// assets; the chat and settings webviews import their styles.css for esbuild.
declare module "*.css";
