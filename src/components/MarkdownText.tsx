import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Split into its own chunk (see MessageBubble): the markdown parser is a
 * large share of the app's JavaScript, and nothing needs it until a finished
 * reply is on screen -- the app shell can paint first.
 */
export default function MarkdownText({ text }: { text: string }) {
  return <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
}
