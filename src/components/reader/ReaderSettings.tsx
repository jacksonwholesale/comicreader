import { X } from 'lucide-react';
import type { Comic, Direction, ReadMode } from '../../db';
import { updateComic } from '../../lib/library';
import { setPrefs, usePrefs, type Prefs } from '../../lib/prefs';

interface Props {
  comic: Comic;
  mode: ReadMode;
  direction: Direction;
  onClose: () => void;
  onMakeDefault: () => void;
}

export function ReaderSettings({ comic, mode, direction, onClose, onMakeDefault }: Props) {
  const prefs = usePrefs();
  const hasOverride = comic.readMode !== undefined || comic.direction !== undefined;
  return (
    <div className="sheet reader-sheet" onPointerDown={(e) => e.stopPropagation()}>
      <div className="sheet-head">
        <h3>Reading settings</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="sheet-body">
        <section>
          <h4>This comic</h4>
          <p className="muted small">
            {mode === 'paged' ? 'Single page' : mode === 'double' ? 'Two-page spread' : mode === 'scroll' ? 'Vertical scroll' : 'Panel by panel'} ·{' '}
            {direction === 'ltr' ? 'Left to right' : 'Right to left (manga)'}
          </p>
          <div className="row gap wrap">
            <button className="btn small" onClick={onMakeDefault}>Use for all comics</button>
            {hasOverride && (
              <button className="btn small ghost" onClick={() => void updateComic(comic.id, { readMode: undefined, direction: undefined })}>
                Reset to default
              </button>
            )}
          </div>
        </section>
        <PrefControls prefs={prefs} />
      </div>
    </div>
  );
}

/** Shared between the in-reader sheet and the Settings page. */
export function PrefControls({ prefs, showDefaults = false }: { prefs: Prefs; showDefaults?: boolean }) {
  return (
    <>
      {showDefaults && (
        <section>
          <h4>Default layout</h4>
          <Seg
            value={prefs.readMode}
            onChange={(readMode) => setPrefs({ readMode })}
            options={[['paged', 'Single'], ['double', 'Double'], ['scroll', 'Scroll'], ['guided', 'Panels']]}
          />
          <Seg value={prefs.direction} onChange={(direction) => setPrefs({ direction })} options={[['ltr', 'Left → Right'], ['rtl', 'Right → Left']]} />
          <Toggle label="Use right-to-left automatically for manga" value={prefs.autoMangaDirection} onChange={(autoMangaDirection) => setPrefs({ autoMangaDirection })} />
        </section>
      )}
      <section>
        <h4>Page fit</h4>
        <Seg value={prefs.fit} onChange={(fit) => setPrefs({ fit })} options={[['screen', 'Screen'], ['width', 'Width'], ['height', 'Height'], ['original', '1:1']]} />
        <Toggle label="Auto-crop borders & margins" value={prefs.autoCrop} onChange={(autoCrop) => setPrefs({ autoCrop })} />
      </section>
      <section>
        <h4>Page turn</h4>
        <Seg value={prefs.transition} onChange={(transition) => setPrefs({ transition })} options={[['slide', 'Slide'], ['turn', 'Page turn'], ['fade', 'Fade'], ['none', 'Instant']]} />
        <label className="field-label">Tap zones</label>
        <Seg value={prefs.tapZones} onChange={(tapZones) => setPrefs({ tapZones })} options={[['edges', 'Edges'], ['halves', 'Halves'], ['off', 'Off (swipe only)']]} />
        <Toggle label="Swap left/right taps" value={prefs.invertTaps} onChange={(invertTaps) => setPrefs({ invertTaps })} />
        <Toggle label="Show cover alone in two-page mode" value={prefs.doubleCoverAlone} onChange={(doubleCoverAlone) => setPrefs({ doubleCoverAlone })} />
        <Toggle label="Panel view: show the full page first" value={prefs.guidedShowFullPageFirst} onChange={(guidedShowFullPageFirst) => setPrefs({ guidedShowFullPageFirst })} />
      </section>
      <section>
        <h4>Vertical scroll</h4>
        <Slider label="Gap between pages" value={prefs.scrollGap} min={0} max={40} unit="px" onChange={(scrollGap) => setPrefs({ scrollGap })} />
        <Slider label="Page width" value={prefs.scrollWidth} min={40} max={100} unit="%" onChange={(scrollWidth) => setPrefs({ scrollWidth })} />
      </section>
      <section>
        <h4>Display</h4>
        <Seg value={prefs.background} onChange={(background) => setPrefs({ background })} options={[['black', 'Black'], ['gray', 'Gray'], ['white', 'White'], ['sepia', 'Sepia']]} />
        <Slider label="Brightness" value={prefs.brightness} min={40} max={120} unit="%" onChange={(brightness) => setPrefs({ brightness })} />
        <Slider label="Night warmth" value={prefs.warmth} min={0} max={100} unit="%" onChange={(warmth) => setPrefs({ warmth })} />
        <Toggle label="Always show page number" value={prefs.alwaysShowPageNumber} onChange={(alwaysShowPageNumber) => setPrefs({ alwaysShowPageNumber })} />
        <Toggle label="Keep screen awake while reading" value={prefs.keepAwake} onChange={(keepAwake) => setPrefs({ keepAwake })} />
      </section>
    </>
  );
}

export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{value}{unit}</output>
    </label>
  );
}
