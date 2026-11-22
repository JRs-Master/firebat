import { Ghost } from 'lucide-react';

/**
 * Brand block — mark, name and tagline, centred. One drawing for two places: the admin chat's
 * empty state and the public home when the CMS "home layout" is set to brand. Both read their
 * words from the caller (the home passes the CMS site title / description), so nothing about a
 * particular site lives here.
 *
 * `iconUrl` = the CMS favicon URL when one is set; without it the mark is the default site icon
 * (app/icon.svg is the same ghost), so the block and the browser tab show the same mark.
 */
export function BrandHero({
  title,
  tagline,
  iconUrl,
  className = '',
}: {
  title: string;
  tagline?: string;
  iconUrl?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-5 select-none ${className}`}>
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-indigo-100 to-blue-200 border border-blue-200 flex items-center justify-center shadow-lg">
        {iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- operator-supplied URL of any origin
          <img src={iconUrl} alt="" className="w-9 h-9 sm:w-11 sm:h-11 object-contain" />
        ) : (
          <>
            <Ghost size={36} className="text-blue-600 sm:hidden" />
            <Ghost size={44} className="text-blue-600 hidden sm:block" />
          </>
        )}
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <h1 className="text-[22px] sm:text-[28px] font-extrabold tracking-tight text-slate-800">{title}</h1>
        {tagline && (
          <p className="text-slate-400 text-[13px] sm:text-[15px] font-medium italic tracking-wide">{tagline}</p>
        )}
      </div>
    </div>
  );
}
