import { Drawer } from 'vaul'
import { Check } from 'lucide-react'
import type { ModelConfig, ReasoningLevel } from '../types.ts'

interface ReasoningPickerProps {
  open: boolean
  /** Per-chat override; null means inherit. */
  value: string | null
  /** The Settings default, used when there is no override. */
  defaultValue?: string
  config: ModelConfig | null
  onChange: (value: string | null) => void
  onClose: () => void
}

// Used only when a model's manifest can't be read -- the generic vocabulary
// the REST API documents.
export const FALLBACK_LEVELS: ReasoningLevel[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'on', label: 'On' },
]

export const levelsFor = (config: ModelConfig | null | undefined): ReasoningLevel[] =>
  (config?.reasoning?.options?.length ? config.reasoning.options : FALLBACK_LEVELS)

// `||` not `??`: an unset default is stored as '' rather than null, and ??
// would let that empty string through as the chip's label.
export const labelFor = (
  value: string | null | undefined,
  fallback: string | null | undefined = null,
): string => value || fallback || 'auto'

export default function ReasoningPicker({
  open, value, defaultValue, config, onChange, onClose,
}: ReasoningPickerProps) {
  const levels = levelsFor(config)
  const modelDefault = config?.reasoning?.default
  const unsupported = config?.found && !config?.reasoning

  const autoHint = defaultValue
    ? `Uses your default: ${defaultValue}`
    : modelDefault
      ? `The model's own default: ${modelDefault}`
      : "The model's own default"

  return (
    <Drawer.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Reasoning effort</Drawer.Title>

          {unsupported ? (
            <div className="hint test-result bad">
              <span>This model doesn&apos;t expose a reasoning setting.</span>
            </div>
          ) : (
            <div className="level-list">
              <button
                type="button"
                className={`level-row${value == null ? ' active' : ''}`}
                aria-pressed={value == null}
                onClick={() => { onChange(null); onClose() }}
              >
                <span className="level-check">
                  {value == null && <Check size={15} aria-hidden="true" />}
                </span>
                <span className="level-text">
                  <span className="level-label">Auto</span>
                  <span className="level-hint">{autoHint}</span>
                </span>
              </button>

              {levels.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className={`level-row${value === l.value ? ' active' : ''}`}
                  aria-pressed={value === l.value}
                  onClick={() => { onChange(l.value); onClose() }}
                >
                  <span className="level-check">
                    {value === l.value && <Check size={15} aria-hidden="true" />}
                  </span>
                  <span className="level-text">
                    <span className="level-label">{l.label}</span>
                    <span className="level-hint">
                      {l.value === modelDefault
                        ? "This model's default"
                        : l.value === 'off' ? 'No thinking: fastest replies' : l.value}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="hint drawer-foot">
            {config?.found
              ? 'Levels come from this model’s LM Studio manifest.'
              : 'Model manifest not found — showing the generic levels.'}
            {' '}Applies to this chat; set the default for new chats in Settings.
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
