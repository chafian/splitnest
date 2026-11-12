import type { ButtonHTMLAttributes, Ref } from 'react';
import { Icon, type IconName } from './Icon';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Accessible name; also shown as the tooltip together with the shortcut. */
  label: string;
  /** Longer explanation for the tooltip only (the accessible name stays short). */
  description?: string;
  shortcut?: string;
  /** `md`: 30px target, `sm`: 28px target (pane and panel headers). Both draw 16px icons. */
  size?: 'sm' | 'md';
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ icon, label, description, shortcut, size = 'md', className, ...rest }: Props) {
  const head = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      className={`icon-button icon-button--${size}${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={description ? `${head}\n${description}` : head}
      {...rest}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}
