import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import * as Tabs from '@radix-ui/react-tabs';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

// Themed shadcn-style primitives. Every color is a §2.2 token; radius 4px; flat
// (1px --rule borders, no card shadow); elevation lives only on dialogs/sheets.

// ---------------------------------------------------------------- Button
type Variant = 'primary' | 'outline' | 'ghost' | 'danger' | 'accent';
type Size = 'sm' | 'md' | 'icon';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-action text-paper border border-action hover:opacity-90',
  outline: 'bg-paper text-ink border border-rule hover:bg-wash',
  ghost: 'bg-transparent text-ink border border-transparent hover:bg-wash',
  danger: 'bg-paper text-debit border border-debit hover:bg-debit-wash',
  accent: 'bg-paper text-action border border-action hover:bg-action-wash',
};
const SIZE: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-[13px]',
  icon: 'h-8 w-8 p-0',
};

/** Shared button styling — usable on <button>, <a> and <Link> to avoid nesting. */
export function buttonClass(variant: Variant = 'outline', size: Size = 'md', className?: string): string {
  return cn(
    'inline-flex items-center justify-center gap-1.5 rounded-sm font-medium whitespace-nowrap',
    'transition-[background-color,color,opacity] duration-150 select-none',
    'disabled:pointer-events-none disabled:opacity-45',
    VARIANT[variant],
    SIZE[size],
    className,
  );
}

export function Button({
  variant = 'outline',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }): ReactNode {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

// ---------------------------------------------------------------- Badge
export type Tone = 'credit' | 'debit' | 'hold' | 'action' | 'neutral';
const TONE: Record<Tone, string> = {
  credit: 'text-credit border-credit/35 bg-credit-wash',
  debit: 'text-debit border-debit/35 bg-debit-wash',
  hold: 'text-hold border-hold/40 bg-hold-wash',
  action: 'text-action border-action/35 bg-action-wash',
  neutral: 'text-ink-60 border-rule bg-wash',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px] leading-none tnum',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  succeeded: 'credit',
  delivered: 'credit',
  done: 'credit',
  finished: 'credit',
  failed: 'debit',
  dead: 'debit',
  requires_retry: 'hold',
  pending: 'hold',
  processing: 'hold',
  running: 'hold',
  created: 'action',
  provider_charged: 'action',
  intent_created: 'action',
  ledger_posted: 'action',
  started: 'neutral',
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status}</Badge>;
}

// ---------------------------------------------------------------- Card / layout
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): ReactNode {
  return <div className={cn('card', className)} {...props} />;
}

export function PageTitle({ children }: { children: ReactNode }): ReactNode {
  return (
    <h1 className="font-serif text-[26px] leading-tight font-semibold text-ink sm:text-[30px]">
      {children}
    </h1>
  );
}

export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): ReactNode {
  return <div className={cn('eyebrow', className)}>{children}</div>;
}

export function SectionHeader({
  title,
  children,
  info,
}: {
  title: ReactNode;
  children?: ReactNode;
  info?: ReactNode;
}): ReactNode {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <Eyebrow>{title}</Eyebrow>
        {info}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Skeleton
export function Skeleton({ className }: { className?: string }): ReactNode {
  return <div className={cn('animate-pulse rounded-sm bg-wash', className)} />;
}

// ---------------------------------------------------------------- Empty / Error
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-start gap-1.5 rounded-sm border border-dashed border-rule bg-wash/40 px-4 py-6">
      <div className="text-sm font-medium text-ink">{title}</div>
      {children ? <div className="text-[13px] text-ink-60">{children}</div> : null}
    </div>
  );
}

export function ErrorState({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="rounded-sm border border-debit/35 bg-debit-wash px-4 py-3 text-[13px] text-debit">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Sheet (side)
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/25 [animation:fadeIn_150ms_ease]" />
        <Dialog.Content
          className={cn(
            'fixed top-0 right-0 z-50 flex h-full w-full max-w-[460px] flex-col',
            'border-l border-rule bg-paper shadow-[0_8px_50px_-12px_rgba(23,24,26,0.35)]',
            'outline-none [animation:sheetIn_180ms_ease]',
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
            <div>
              <Dialog.Title className="font-serif text-lg font-semibold text-ink">
                {title}
              </Dialog.Title>
              {subtitle ? (
                <Dialog.Description className="mt-0.5 font-mono text-xs text-ink-60">
                  {subtitle}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">Detail panel</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close panel">
                <X size={16} />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------- Info popover
export function InfoPopover({
  label = 'How this works',
  children,
}: {
  label?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          aria-label={label}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-rule bg-paper font-mono text-[11px] leading-none text-ink-60 transition-colors hover:border-action hover:text-action"
        >
          i
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-50 w-[300px] rounded-sm border border-rule bg-paper p-3.5',
            'shadow-[0_8px_40px_-12px_rgba(23,24,26,0.3)] outline-none [animation:dialogIn_150ms_ease]',
            'text-[13px] leading-relaxed text-ink',
          )}
        >
          {children}
          <Popover.Arrow className="fill-[--color-paper] stroke-[--color-rule]" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------- Tabs
export const TabsRoot = Tabs.Root;
export function TabsList({ children }: { children: ReactNode }): ReactNode {
  return (
    <Tabs.List className="flex items-stretch gap-0 border-b border-rule">{children}</Tabs.List>
  );
}
export function TabTrigger({ value, children }: { value: string; children: ReactNode }): ReactNode {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        'relative -mb-px border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-ink-60',
        'transition-colors hover:text-ink data-[state=active]:border-action data-[state=active]:text-ink',
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}
export const TabPanel = Tabs.Content;

// ---------------------------------------------------------------- Slider
export function Slider({
  value,
  min,
  max,
  step,
  onValueChange,
  'aria-label': ariaLabel,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (v: number) => void;
  'aria-label'?: string;
}): ReactNode {
  return (
    <SliderPrimitive.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onValueChange(v[0] ?? min)}
      aria-label={ariaLabel}
      className="relative flex h-5 w-full touch-none items-center select-none"
    >
      <SliderPrimitive.Track className="relative h-1 grow rounded-full bg-rule">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-hold" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block h-3.5 w-3.5 rounded-full border border-hold bg-paper shadow-sm transition-transform hover:scale-110" />
    </SliderPrimitive.Root>
  );
}
