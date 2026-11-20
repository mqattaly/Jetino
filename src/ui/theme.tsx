import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Moon, MonitorSmartphone, Palette, RotateCcw, Sun } from 'lucide-react';

/**
 * Theme + accent are two independent choices, exactly like the reference swatches:
 * light / dark / auto, and one primary colour out of five. Both are written to the
 * <html> element, so a single attribute change re-paints every screen without any
 * component knowing about it. `index.html` repeats the same read before first paint,
 * which is why a reload never flashes the wrong palette.
 */

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ThemeAccent = 'crimson' | 'cyan' | 'teal' | 'orange' | 'magenta';

const MODE_KEY = 'jetino.theme.v2';
const ACCENT_KEY = 'jetino.accent.v2';
export const DEFAULT_MODE: ThemeMode = 'auto';
export const DEFAULT_ACCENT: ThemeAccent = 'crimson';

export const accentNames: Record<ThemeAccent, string> = {
  crimson: 'زرشکی',
  cyan: 'آبی',
  teal: 'فیروزه‌ای',
  orange: 'نارنجی',
  magenta: 'ارغوانی',
};

const isMode = (value: unknown): value is ThemeMode => value === 'light' || value === 'dark' || value === 'auto';
const isAccent = (value: unknown): value is ThemeAccent => typeof value === 'string' && value in accentNames;

function readStored<T>(key: string, fallback: T, guard: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return guard(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function paint(mode: ThemeMode, accent: ThemeAccent) {
  const root = document.documentElement;
  const resolved = mode === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : mode;
  root.dataset.theme = resolved;
  root.dataset.themeMode = mode;
  root.dataset.accent = accent;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a1420' : '#f2f6fb');
}

type ThemeContextValue = {
  mode: ThemeMode;
  accent: ThemeAccent;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  setAccent: (accent: ThemeAccent) => void;
  reset: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored(MODE_KEY, DEFAULT_MODE, isMode));
  const [accent, setAccentState] = useState<ThemeAccent>(() => readStored(ACCENT_KEY, DEFAULT_ACCENT, isAccent));
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));

  const apply = useCallback((nextMode: ThemeMode, nextAccent: ThemeAccent) => {
    paint(nextMode, nextAccent);
    setResolved(nextMode === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : nextMode);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* private mode */ }
  }, []);

  const setAccent = useCallback((next: ThemeAccent) => {
    setAccentState(next);
    try { window.localStorage.setItem(ACCENT_KEY, next); } catch { /* private mode */ }
  }, []);

  const reset = useCallback(() => {
    setMode(DEFAULT_MODE);
    setAccent(DEFAULT_ACCENT);
  }, [setMode, setAccent]);

  useEffect(() => { apply(mode, accent); }, [apply, mode, accent]);

  // auto follows the operating system while the tab is open, without a reload
  useEffect(() => {
    if (mode !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('auto', accent);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [apply, accent, mode]);

  // another tab changing the theme should not leave this one behind
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === MODE_KEY && isMode(event.newValue)) setModeState(event.newValue);
      if (event.key === ACCENT_KEY && isAccent(event.newValue)) setAccentState(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ mode, accent, resolved, setMode, setAccent, reset }), [mode, accent, resolved, setMode, setAccent, reset]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}

const modes: Array<{ key: ThemeMode; label: string; icon: typeof Sun }> = [
  { key: 'light', label: 'روشن', icon: Sun },
  { key: 'dark', label: 'تیره', icon: Moon },
  { key: 'auto', label: 'خودکار', icon: MonitorSmartphone },
];

const accents: ThemeAccent[] = ['crimson', 'cyan', 'teal', 'orange', 'magenta'];

/** The theme cards + colour row from the reference image, built from gradients and masks. */
export function ThemePicker({ compact = false }: { compact?: boolean }) {
  const { mode, accent, setMode, setAccent, reset } = useTheme();
  return <div className={compact ? 'theme-picker compact' : 'theme-picker'}>
    <p>روشنایی و رنگ اصلی را انتخاب کنید؛ انتخاب شما روی همین دستگاه ذخیره می‌شود.</p>
    <div className="theme-grid" role="radiogroup" aria-label="تم ظاهری">
      {modes.map(({ key, label }) => <button
        key={key}
        type="button"
        role="radio"
        aria-checked={mode === key}
        className="theme-card"
        onClick={() => setMode(key)}
      >
        <span className={`scene ${key}`} aria-hidden="true" />
        <span>{label}</span>
      </button>)}
    </div>
    <h3>رنگ اصلی</h3>
    <div className="theme-swatches" role="radiogroup" aria-label="رنگ اصلی">
      {accents.map(name => <button
        key={name}
        type="button"
        role="radio"
        aria-checked={accent === name}
        aria-label={accentNames[name]}
        title={accentNames[name]}
        className={`swatch ${name}`}
        onClick={() => setAccent(name)}
      >
        {accent === name && <Check size={18} strokeWidth={3} />}
      </button>)}
    </div>
    <button type="button" className="theme-reset" onClick={reset}><RotateCcw size={13} />بازگشت به پیش‌فرض (تیرهٔ خودکار، زرشکی)</button>
  </div>;
}

/**
 * A single floating control that every screen gets for free, because it is mounted in
 * `main.tsx` next to the routed app. On phones it sits above the bottom tab bar.
 */
export function ThemeDock() {
  const [open, setOpen] = useState(false);
  const dock = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      if (dock.current && !dock.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return <div className="theme-dock" ref={dock}>
    {open && <div className="theme-panel" role="dialog" aria-label="تنظیم ظاهر">
      <ThemePicker />
    </div>}
    <button type="button" className="theme-fab" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Palette size={17} />ظاهر
    </button>
  </div>;
}
