/** Fixtures are imported as text via Vite's `?raw` suffix. */
declare module "*?raw" {
  const content: string;
  export default content;
}
