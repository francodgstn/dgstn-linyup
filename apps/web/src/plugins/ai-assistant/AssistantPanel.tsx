'use client'

// AI assistant launcher — a floating button + slide-over chat panel. Read-only:
// it answers from the studio's data through the public API's read tools, as far
// as the signed-in member's role allows and never contact details, and helps
// with navigation; it takes no actions (functions assistant/, docs/public-api.md
// → "Read tools"). Self-gates on
// the (locked) ai-assistant plugin being installed for the current team, so it
// only appears once the operator has unlocked it. Mounted once in the auth layout.

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { httpsCallable } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import { useAuth } from '@/contexts/AuthContext'
import { useInstalledPlugins } from '@/hooks/useInstalledPlugins'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { FloatingSlot } from '@/components/layout/FloatingDock'
import { Sparkles, Send, Loader2 } from 'lucide-react'
import { Tip } from '@/components/ui/tip'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

export default function AssistantLauncher() {
  const { isInstalled } = useInstalledPlugins()
  // Only render once the (locked) plugin is unlocked/installed for this team.
  if (!isInstalled('ai-assistant')) return null
  return <AssistantPanel />
}

function AssistantPanel() {
  const t = useTranslations('AiAssistant')
  const { currentTeamId } = useAuth()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  async function send() {
    const text = input.trim()
    if (!text || sending || !currentTeamId) return
    const next = [...messages, { role: 'user' as const, content: text }]
    setMessages(next)
    setInput('')
    setSending(true)
    setError(null)
    try {
      const res = await httpsCallable(functions, 'assistantChat')({ teamId: currentTeamId, messages: next })
      const reply = (res.data as { reply?: string })?.reply?.trim()
      if (!reply) throw new Error('empty')
      setMessages((m) => [...m, { role: 'assistant', content: reply }])
    } catch {
      setError(t('error'))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {/* Floating launcher, in the shell lane — stacked above whatever primary
          action the page mounted, or in the corner if it mounted none. The
          position is the dock's, not ours: this used to hardcode the bottom-right
          corner and swallow taps meant for a page FAB or a dirty form's Save
          (UX-9). Never give this a `fixed bottom-*` again. */}
      <FloatingSlot lane="shell">
        <Tip label={t('launcherLabel')}>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('launcherLabel')}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors"
          >
            <Sparkles className="h-5 w-5" />
          </button>
        </Tip>
      </FloatingSlot>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-md!">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              {t('title')}
            </SheetTitle>
            <SheetDescription className="text-xs">{t('disclaimer')}</SheetDescription>
          </SheetHeader>

          {/* Thread */}
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {messages.length === 0 && (
              <p className="mt-6 text-center text-sm text-muted-foreground">{t('greeting')}</p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('thinking')}
                </div>
              </div>
            )}
            {error && <p className="text-center text-sm text-destructive">{error}</p>}
          </div>

          {/* Composer */}
          <div className="flex items-center gap-2 border-t px-4 py-3">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('inputPlaceholder')}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              disabled={sending}
            />
            <Button size="icon" onClick={send} disabled={!input.trim() || sending} aria-label={t('send')}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
