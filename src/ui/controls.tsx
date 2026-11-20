import type { ComponentType, ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';

type Icon = ComponentType<LucideProps>;

/**
 * The one button in the new interface: an icon and a word, always together.
 * Variants map to the palette, never to a new colour invented at the call site.
 */
export function ActionButton({
  icon: Icon, children, variant = 'primary', size = 'md', onClick, disabled, type = 'button', title, className = '',
}: {
  icon?: Icon;
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  const variantClass = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : 'btn-ghost';
  const sizeClass = size === 'lg' ? 'btn-lg' : size === 'sm' ? 'btn-sm' : '';
  return <button type={type} title={title} className={`btn ${variantClass} ${sizeClass} ${className}`.trim()} disabled={disabled} onClick={onClick}>
    {Icon && <Icon size={size === 'sm' ? 14 : 16} />}
    <span>{children}</span>
  </button>;
}

/** Stacked icon-tile: for quick actions where the icon has to lead. */
export function TileButton({
  icon: Icon, children, active = false, onClick, badge,
}: { icon: Icon; children: ReactNode; active?: boolean; onClick?: () => void; badge?: ReactNode }) {
  return <button type="button" className={`tile-btn${active ? ' is-active' : ''}`} onClick={onClick} aria-pressed={active}>
    <Icon size={22} />
    <span>{children}</span>
    {badge}
  </button>;
}

/** A compact number tile used by the gallery and the operational headers. */
export function StatTile({ label, value, hint, tone = 'brand' }: { label: string; value: ReactNode; hint?: string; tone?: 'brand' | 'teal' | 'warn' | 'neutral' }) {
  return <div className={`stat-tile tone-${tone}`}>
    <span className="stat-tile-label">{label}</span>
    <strong>{value}</strong>
    {hint && <small>{hint}</small>}
  </div>;
}
