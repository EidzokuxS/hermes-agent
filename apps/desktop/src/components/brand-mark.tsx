import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Product-owned vector mark. It stays legible from the title bar through the
// installer without relying on a theme-specific tile or a mascot asset.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-[22%]',
        className
      )}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={assetPath('nox-mark.svg')} />
    </span>
  )
}
