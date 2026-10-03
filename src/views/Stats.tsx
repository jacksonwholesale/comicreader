import { useLiveQuery } from 'dexie-react-hooks';
import { Monitor, Smartphone } from 'lucide-react';
import { useMemo } from 'react';
import { db } from '../db';
import { computeStats, formatDuration, isReadable, statusOf, timeAgo } from '../lib/library';
import { useLibrary } from '../lib/useLibrary';
import { Cover } from '../components/ComicCard';

export function Stats({ onRead }: { onRead: (id: string) => void }) {
  const sessions = useLiveQuery(() => db.sessions.orderBy('startedAt').reverse().toArray(), [], []);
  const { comics, progress } = useLibrary();
  const byId = useMemo(() => new Map((comics ?? []).map((c) => [c.id, c])), [comics]);
  const stats = useMemo(() => computeStats(sessions), [sessions]);
  const finished = (comics ?? []).filter((c) => statusOf(progress.get(c.id)) === 'finished').length;

  // minutes per day for the last 14 days
  const days = useMemo(() => {
    const out: { label: string; min: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const start = d.getTime();
      const end = start + 86400_000;
      const ms = sessions.filter((s) => s.startedAt >= start && s.startedAt < end).reduce((a, s) => a + (s.endedAt - s.startedAt), 0);
      out.push({ label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), min: Math.round(ms / 60000) });
    }
    return out;
  }, [sessions]);
  const maxMin = Math.max(10, ...days.map((d) => d.min));

  return (
    <div className="view">
      <header className="view-head"><h1>Reading</h1></header>
      <div className="stat-tiles">
        <Tile label="Time reading" value={formatDuration(stats.totalMs)} />
        <Tile label="Pages viewed" value={stats.pages.toLocaleString()} />
        <Tile label="Comics finished" value={String(finished)} />
        <Tile label="Day streak" value={String(stats.streak)} />
      </div>

      <section className="panel">
        <h2>Last 14 days</h2>
        <div className="bars" role="img" aria-label="Minutes read per day over the last 14 days">
          {days.map((d, i) => (
            <div key={i} className="bar-col" title={`${d.min} min`}>
              <div className="bar" style={{ height: `${(d.min / maxMin) * 100}%` }} />
              <span>{d.label}</span>
            </div>
          ))}
        </div>
      </section>

      {stats.byDevice.size > 0 && (
        <section className="panel">
          <h2>By device</h2>
          <ul className="device-list">
            {[...stats.byDevice.entries()].sort((a, b) => b[1] - a[1]).map(([name, ms]) => (
              <li key={name}>
                {/phone|iphone|android/i.test(name) ? <Smartphone size={18} /> : <Monitor size={18} />}
                <span className="grow">{name}</span>
                <strong>{formatDuration(ms)}</strong>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel">
        <h2>Recent sessions</h2>
        {!sessions.length && <p className="muted">Sessions appear here as you read, from every synced device.</p>}
        <ul className="session-list">
          {sessions.slice(0, 40).map((s) => {
            const c = byId.get(s.comicId);
            return (
              <li key={s.id}>
                {c ? <Cover comic={c} className="session-cover" /> : <div className="cover session-cover" />}
                <button className="grow session-main" disabled={!c || !isReadable(c)} onClick={() => c && onRead(c.id)}>
                  <strong>{c?.title ?? 'Removed comic'}</strong>
                  <span className="muted small">
                    Pages {s.startPage + 1}–{s.endPage + 1} · {formatDuration(s.endedAt - s.startedAt)} · {s.deviceName}
                  </span>
                </button>
                <span className="muted small">{timeAgo(s.startedAt)}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
    </div>
  );
}
