import { forwardRef, useId } from 'react';

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, error, hint, className = '', ...rest }, ref) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-label font-medium text-ink">
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? `${id}-help` : undefined}
        className={`h-11 rounded-input bg-surface-muted px-4 text-body text-ink placeholder:text-ink-3 ${error ? 'border border-danger-fg' : 'border border-transparent'}`}
        {...rest}
      />
      {(error || hint) && (
        <p id={`${id}-help`} className={`text-small ${error ? 'text-danger-fg' : 'text-ink-3'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
});

export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-pill bg-surface-muted p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={`h-10 cursor-pointer rounded-pill px-4 text-label font-medium transition-colors duration-150 disabled:cursor-not-allowed ${
              active ? 'bg-primary text-white' : 'text-ink-2 hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
