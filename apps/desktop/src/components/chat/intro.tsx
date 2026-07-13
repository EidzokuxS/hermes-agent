import type { CSSProperties } from 'react'

import { useI18n } from '@/i18n'
import { PRODUCT_WORDMARK } from '@/product'

export type IntroProps = Record<string, never>

export function Intro() {
  const { t } = useI18n()

  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center px-0.5 py-6 text-center text-muted-foreground sm:px-6 lg:px-8"
      data-slot="aui_intro"
    >
      <div className="w-full min-w-0">
        <p
          aria-label={PRODUCT_WORDMARK}
          className="fit-text mx-auto mb-1 w-[calc(100%-1rem)] font-['Collapse'] font-bold uppercase leading-[0.9] tracking-[0.08em] text-midground mix-blend-plus-lighter dark:text-foreground/90"
          style={{ '--fit-min': '2.75rem' } as CSSProperties}
        >
          <span>
            <span>{PRODUCT_WORDMARK}</span>
          </span>
          <span aria-hidden="true">{PRODUCT_WORDMARK}</span>
        </p>

        <p className="m-0 text-center leading-normal tracking-tight">{t.composer.introDescription}</p>
      </div>
    </div>
  )
}
