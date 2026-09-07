import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { totalWaiting, useOpenInvites } from '../joinAlerts';
import { useT } from '../i18n/useT';

/**
 * The bell in the top bar: somebody is waiting to be let into a group this
 * account administers.
 *
 * One group and it is a link straight to that group's members tab, because a
 * list of one is a click that asks a question with a single answer. More than
 * one and it opens a short list, since the bell cannot know which group is
 * meant. It renders nothing at all when nothing is waiting.
 */
const membersPath = (groupId: string): string => `/g/${groupId}?tab=members`;

/** Drawn rather than an emoji: 🔔 is coloured by the font and cannot be made red. */
function Bell({ count }: { count: number }) {
  return (
    <span className="relative inline-flex">
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
        <path d="M10 1.6a1 1 0 0 0-1 1v.7A5 5 0 0 0 5.2 8.1v2.6l-1.1 1.9a1 1 0 0 0 .9 1.5h10a1 1 0 0 0 .9-1.5l-1.1-1.9V8.1A5 5 0 0 0 11 3.3v-.7a1 1 0 0 0-1-1z" />
        <path d="M8 15.1a2 2 0 0 0 4 0z" />
      </svg>
      {/* Only past one: a lone bell already says "one", and a badge reading 1
          is a number nobody needed to read. */}
      {count > 1 && (
        <span aria-hidden="true" className="absolute -right-2.5 -top-2 min-w-[1.05rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-[1.05rem] text-white">
          {count}
        </span>
      )}
    </span>
  );
}

export function InviteBell({ meId }: { meId: string }) {
  const t = useT();
  const groups = useOpenInvites(meId);
  const [open, setOpen] = useState(false);
  const total = totalWaiting(groups);

  // Somebody else approved the second-to-last request while the list was up:
  // it would otherwise stay open over a single row, or over none.
  useEffect(() => {
    if (groups.length < 2) setOpen(false);
  }, [groups.length]);

  if (total === 0) return null;
  const label = t('shell.waitingToJoin', { count: total });
  // The badge overhangs the icon, so it needs a little more room than the
  // header's own gap before the name beside it.
  const tint = 'mr-2 text-red-600 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400';

  if (groups.length === 1) {
    return (
      <Link to={membersPath(groups[0]!.groupId)} title={label} aria-label={label} className={tint}>
        <Bell count={total} />
      </Link>
    );
  }

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        aria-expanded={open}
        className={tint}
      >
        <Bell count={total} />
      </button>
      {open && (
        <>
          {/* Catches the next click anywhere, which is how a popover closes. */}
          <button
            type="button"
            aria-label={t('shell.closeList')}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div className="absolute right-0 z-50 mt-2 w-60 overflow-hidden rounded-lg border border-slate-200 bg-white text-left shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <p className="border-b border-slate-100 px-3 py-2 text-xs font-medium text-slate-500 dark:border-slate-800 dark:text-slate-400">
              {label}
            </p>
            <ul>
              {groups.map((g) => (
                <li key={g.groupId}>
                  <Link
                    to={membersPath(g.groupId)}
                    onClick={() => setOpen(false)}
                    className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {/* A group whose key has not arrived yet, named the way the
                        groups page names it rather than as a blank row. */}
                    <span className="truncate">
                      {g.name === '' ? (
                        <span className="italic text-slate-500 dark:text-slate-400">{t('group.awaitingKeys')}</span>
                      ) : (
                        g.name
                      )}
                    </span>
                    <span className="shrink-0 rounded-full bg-red-600 px-1.5 text-[10px] font-bold leading-4 text-white">
                      {g.count}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </span>
  );
}
