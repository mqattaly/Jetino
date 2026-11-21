import { useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { photoToDataUrl } from './media';

/**
 * One control for every photo in the product: a dish photo, a courier's face. It previews what
 * the customer will see, keeps the file small and reports a readable Persian error instead of a
 * failed request.
 */
export function PhotoField({ label, hint, value, onChange, disabled = false, alt = '' }: {
  label: string;
  hint?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  alt?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError('');
    try { onChange(await photoToDataUrl(file)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };

  return <div className="photo-field">
    <div className="photo-field-label">{label}{hint && <small>{hint}</small>}</div>
    <div className="photo-field-row">
      <span className={`photo-field-preview${value ? ' has-photo' : ''}`}>
        {value ? <img src={value} alt={alt || label} /> : <ImagePlus size={22} aria-hidden="true" />}
      </span>
      <div className="photo-field-actions">
        <button type="button" className="menu-edit" disabled={disabled || busy} onClick={() => input.current?.click()}>
          {busy ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />}
          {busy ? 'در حال آماده‌سازی…' : value ? 'تغییر عکس' : 'انتخاب عکس'}
        </button>
        {value && <button type="button" className="menu-edit" disabled={disabled || busy} onClick={() => onChange(null)}><Trash2 size={14} />حذف عکس</button>}
      </div>
      <input ref={input} className="photo-field-input" type="file" accept="image/jpeg,image/png,image/webp" aria-label={label} onChange={e => void pick(e.target.files?.[0])} />
    </div>
    {error ? <p className="photo-field-error" role="alert">{error}</p> : <small className="photo-field-hint">{hint || 'JPEG، PNG یا WebP؛ پیش از ارسال فشرده و کوچک می‌شود.'}</small>}
  </div>;
}
