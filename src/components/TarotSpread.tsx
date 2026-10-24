// Shared with Orrery: edit here in lm-chat, then run `npm run sync:shared` in Orrery.
import { imageFor, layoutFor, turnOf } from '../lib/tarotSpread.ts'
import type { Reading } from '../lib/tarotSpread.ts'

/** A card's aspect, the deck's: 2.75 by 4.75 inches. */
const RATIO = 2.75 / 4.75

const label = (c: Reading['cards'][number]): string => `${c.card.name}${c.reversed ? ', reversed' : ''}`

/**
 * The cards of a reading as they were laid: a row for a line of cards, the
 * cross and staff for a Celtic Cross, each card upright or reversed as it
 * fell, with its position named. The reading itself is the model's to give.
 * `image` gives a card's picture, when the app serves them elsewhere than imageFor's.
 */
export default function TarotSpread({ reading, image = imageFor }: { reading: Reading; image?: (id: string) => string }) {
  const layout = layoutFor(reading.spread.id, reading.cards.length)
  const title = `${reading.spread.name}${reading.question ? `: ${reading.question}` : ''}`

  if (layout.kind === 'row') {
    return (
      <figure className="tarot" aria-label={title}>
        <div className={`tarot-row cards-${Math.min(reading.cards.length, 5)}`}>
          {reading.cards.map((c, i) => (
            <figure key={c.position.index} className="tarot-card">
              <img src={image(c.card.id)} alt={`${c.position.name}: ${label(c)}`} style={{ transform: `rotate(${turnOf(layout.slots[i]!, c.reversed)}deg)` }} loading="lazy" />
              <figcaption><span className="tarot-pos">{c.position.name}</span><span className="tarot-name">{label(c)}</span></figcaption>
            </figure>
          ))}
        </div>
        <figcaption className="tarot-title">{title}</figcaption>
      </figure>
    )
  }

  // The cross: each card placed by its slot, the picture's height following from its width.
  const height = (layout.rows / layout.cols / RATIO) * 100
  return (
    <figure className="tarot" aria-label={title}>
      <div className="tarot-cross" style={{ paddingBottom: `${height}%` }}>
        {reading.cards.map((c, i) => {
          const slot = layout.slots[i]!
          return (
            <div key={c.position.index} className="tarot-slot" style={{ left: `${(slot.x / layout.cols) * 100}%`, top: `${(slot.y / layout.rows) * 100}%`, width: `${(1 / layout.cols) * 100}%`, zIndex: slot.turn ? 2 : 1 }} title={`${c.position.index} ${c.position.name}: ${label(c)}`}>
              <img src={image(c.card.id)} alt={`${c.position.index}. ${c.position.name}: ${label(c)}`} style={{ transform: `rotate(${turnOf(slot, c.reversed)}deg)` }} loading="lazy" />
              <span className="tarot-num" aria-hidden="true">{c.position.index}</span>
            </div>
          )
        })}
      </div>
      <ol className="tarot-legend">
        {reading.cards.map((c) => <li key={c.position.index}><span className="tarot-pos">{c.position.name}</span><span className="tarot-name">{label(c)}</span></li>)}
      </ol>
      <figcaption className="tarot-title">{title}</figcaption>
    </figure>
  )
}
