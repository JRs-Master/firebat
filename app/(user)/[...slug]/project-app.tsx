/**
 * ProjectAppView — a page project whose root IS an app, served from its own files.
 *
 * The app lives in `user/pages/<name>/web/` and is delivered by the route beside it, so it is a
 * real document with no CSP of ours attached: it may split itself into files, run workers, and load
 * what it needs. That is the whole reason a file-based app exists — an `Html` block carrying a
 * script goes into an iframe `srcdoc` whose CSP has no `'self'`, where the page's own scripts are
 * blocked with no error at all.
 *
 * The URL stays the project's own (`/carom`), because that is the address a person keeps. Nothing
 * is duplicated to make that work: the directory is the project, and the DB row it used to need is
 * gone.
 */

/** Same full-bleed lock the inline app path uses (page.tsx `isApp`): header and footer hidden, page
 *  scroll off, so the only scroll is the app's own. Kept identical on purpose — two apps on this
 *  site should not sit differently depending on where their bytes came from. */
const LOCK_CSS =
  '[data-cms-header],[data-cms-footer]{display:none!important}' +
  'html{scrollbar-gutter:auto}html,body{margin:0;padding:0;overflow:hidden;height:auto}' +
  'body>main{margin:0;padding:0}' +
  '.firebat-cms-content{margin:0!important;padding:0!important;max-width:none!important}';

export function ProjectAppView({ projectName }: { projectName: string }) {
  const src = `/user/pages/${encodeURIComponent(projectName)}/`;
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LOCK_CSS }} />
      <main className="bg-white">
        <iframe
          src={src}
          title={projectName}
          // No sandbox attribute: this document is ours, served by our own gated route. Sandboxing
          // it would re-create the restriction the file layout exists to escape.
          allow="autoplay; fullscreen; microphone; camera; clipboard-write; xr-spatial-tracking"
          style={{ display: 'block', width: '100%', height: '100dvh', border: 0 }}
        />
      </main>
    </>
  );
}
