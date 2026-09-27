import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { MdImage } from './MdImage'

export function Markdown({
  content,
  className,
  imageBase = ''
}: {
  content: string
  className?: string
  /**
   * 笔记所在目录（相对知识库根）。正文里的图片写的是**相对笔记**的路径，
   * 只有知道这个基准才能把它换成能加载的地址。
   */
  imageBase?: string
}): JSX.Element {
  return (
    <div className={cn('md-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault()
                if (href) void window.papervault.app.openExternal(href)
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => (
            <MdImage
              src={typeof src === 'string' ? src : undefined}
              alt={alt}
              imageBase={imageBase}
            />
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
