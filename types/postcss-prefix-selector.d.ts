/** postcss-prefix-selector 의 ambient 타입 — 패키지가 자체 d.ts 제공 안 함.
 *  실제 사용 시그니처: prefixer({ prefix, transform }) → PostCSS Plugin. */
declare module 'postcss-prefix-selector' {
  import type { Plugin } from 'postcss';
  interface PrefixerOptions {
    prefix: string;
    exclude?: Array<string | RegExp>;
    ignoreFiles?: Array<string | RegExp>;
    includeFiles?: Array<string | RegExp>;
    transform?: (prefix: string, selector: string, prefixedSelector: string, filePath?: string, rule?: unknown) => string;
  }
  function prefixer(opts: PrefixerOptions): Plugin;
  export default prefixer;
}
