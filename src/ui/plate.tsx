import { useEffect, useRef, useState } from 'react';

/**
 * Iranian plate input, laid out like the real plate: the two province digits sit
 * under the word «ایران», then the three digits, the serial letter and the final
 * two digits, with the blue I.R. IRAN strip on the far left.
 *
 * The stored value stays compact and ASCII for the API: `94` + `346` + `ط` + `23`
 * becomes `94346ط23`. Older `12ب34567` plates keep working and are shown as-is.
 */

export const PLATE_LETTERS = ['ب', 'ج', 'د', 'س', 'ص', 'ط', 'ق', 'ل', 'م', 'ن', 'و', 'ه', 'ی'];

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const toPersianDigits = (value: string) => value.replace(/\d/g, digit => FA_DIGITS[Number(digit)]);

const toLatinDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, digit => String(FA_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(AR_DIGITS.indexOf(digit)))
    .replace(/\D/g, '');

export type PlateParts = { province: string; serial: string; letter: string; tail: string };

export function parsePlate(raw: string | null | undefined): PlateParts {
  const value = (raw ?? '')
    .replace(/[۰-۹]/g, digit => String(FA_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(AR_DIGITS.indexOf(digit)))
    .replace(/[\s\-_]/g, '');
  const current = value.match(/^(\d{2})(\d{3})([^\d])(\d{2})$/);
  if (current) return { province: current[1], serial: current[2], letter: current[3], tail: current[4] };
  const legacy = value.match(/^(\d{2})([^\d])(\d{5})$/);
  if (legacy) return { province: legacy[1], serial: legacy[3].slice(0, 3), letter: legacy[2], tail: legacy[3].slice(3) };
  return { province: '', serial: '', letter: '', tail: '' };
}

export function composePlate({ province, serial, letter, tail }: PlateParts): string {
  return province.length === 2 && serial.length === 3 && letter.length === 1 && tail.length === 2
    ? `${province}${serial}${letter}${tail}`
    : '';
}

/** `94346ط23` → `94 346ط23`; older plates and anything unrecognised are returned untouched. */
export function prettyPlate(raw: string | null | undefined): string {
  if (!raw) return '';
  const compact = raw
    .replace(/[۰-۹]/g, digit => String(FA_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, digit => String(AR_DIGITS.indexOf(digit)))
    .replace(/[\s\-_]/g, '');
  if (!/^\d{2}\d{3}[^\d]\d{2}$/.test(compact)) return raw;
  const parts = parsePlate(raw);
  return `${parts.province} ${parts.serial}${parts.letter}${parts.tail}`;
}

const compact = (raw: string | null | undefined) => (raw ?? '').replace(/[\s\-_]/g, '');

/** Only a plate that composes back to itself can be edited in four parts; older plates start blank. */
function editableParts(raw: string | null | undefined): PlateParts {
  const parts = parsePlate(raw);
  return composePlate(parts) && composePlate(parts) === compact(raw) ? parts : { province: '', serial: '', letter: '', tail: '' };
}

export function PlateInput({
  value,
  onChange,
  disabled = false,
  hint,
  autoFocus = false,
}: {
  value: string;
  onChange: (plate: string) => void;
  disabled?: boolean;
  hint?: string;
  autoFocus?: boolean;
}) {
  const [parts, setParts] = useState<PlateParts>(() => editableParts(value));
  const lastEmitted = useRef(value);

  // a saved plate arriving from the API (or a reset) replaces the parts, but never
  // the value this component just emitted itself while the driver is typing
  useEffect(() => {
    if (value === lastEmitted.current) return;
    lastEmitted.current = value;
    setParts(editableParts(value));
  }, [value]);

  const legacyPlate = Boolean(value) && !composePlate(parsePlate(value));

  const update = (patch: Partial<PlateParts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    const composed = composePlate(next);
    lastEmitted.current = composed;
    onChange(composed);
  };

  return (
    <div className="plate-field">
      <div className="plate-input" dir="rtl" aria-label="شمارهٔ پلاک خودرو">
        <span className="plate-input-iran">
          <span className="plate-input-flag" aria-hidden="true" />
          <span className="plate-input-iran-text">ایران</span>
          <input
            className="plate-input-part plate-input-province"
            inputMode="numeric"
            maxLength={2}
            placeholder="۹۴"
            aria-label="دو رقم زیر ایران"
            value={toPersianDigits(parts.province)}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={event => update({ province: toLatinDigits(event.target.value).slice(0, 2) })}
          />
        </span>
        <span className="plate-input-cell">
          <input
            className="plate-input-part plate-input-serial"
            inputMode="numeric"
            maxLength={3}
            placeholder="۳۴۶"
            aria-label="سه رقم پلاک"
            value={toPersianDigits(parts.serial)}
            disabled={disabled}
            onChange={event => update({ serial: toLatinDigits(event.target.value).slice(0, 3) })}
          />
        </span>
        <span className="plate-input-cell">
          <select
            className="plate-input-part plate-input-letter"
            aria-label="حرف پلاک"
            value={parts.letter}
            disabled={disabled}
            onChange={event => update({ letter: event.target.value })}
          >
            <option value="">حرف</option>
            {PLATE_LETTERS.map(letter => (
              <option key={letter} value={letter}>{letter}</option>
            ))}
          </select>
        </span>
        <span className="plate-input-cell">
          <input
            className="plate-input-part plate-input-tail"
            inputMode="numeric"
            maxLength={2}
            placeholder="۲۳"
            aria-label="دو رقم آخر پلاک"
            value={toPersianDigits(parts.tail)}
            disabled={disabled}
            onChange={event => update({ tail: toLatinDigits(event.target.value).slice(0, 2) })}
          />
        </span>
        <span className="plate-input-strip" aria-hidden="true">
          <span>I.R.</span>
          <span>IRAN</span>
        </span>
      </div>
      {legacyPlate && (
        <small className="plate-input-legacy">
          پلاک ثبت‌شدهٔ فعلی: <b dir="ltr">{value}</b> — برای ویرایش، چهار بخش بالا را کامل کنید.
        </small>
      )}
      {hint && <small className="plate-input-hint">{hint}</small>}
    </div>
  );
}
