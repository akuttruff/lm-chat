import { useState, useEffect, useCallback, useRef } from 'react';
import { Drawer } from 'vaul';
import { Eye, EyeOff, Check, CircleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { levelsFor } from './ReasoningPicker';
import type { ModelConfig, PublicConfig } from '../types.ts';

interface SettingsSheetProps {
  open: boolean;
  config: PublicConfig | null;
  modelConfig: ModelConfig | null;
  onSave: (patch: Partial<PublicConfig> & { apiToken?: string }) => Promise<void>;
  onClose: () => void;
}

interface ProbeResult {
  ok: boolean;
  text: string;
}

/**
 * Settings live on the server now, so this edits server state rather than
 * this device's. The API token is write-only: the server reports whether one
 * is set, never what it is.
 */
export default function SettingsSheet({ open, config, modelConfig, onSave, onClose }: SettingsSheetProps) {
  const [lmStudioUrl, setLmStudioUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [mcpTools, setMcpTools] = useState('');
  const [contextLength, setContextLength] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [stallSeconds, setStallSeconds] = useState('180');
  const [historyChars, setHistoryChars] = useState('24000');
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [showToken, setShowToken] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    if (!open || !config || loaded.current) return;
    loaded.current = true;
    setLmStudioUrl(config.lmStudioUrl);
    setModel(config.model);
    setSystemPrompt(config.systemPrompt);
    setMcpTools(config.mcpTools);
    setContextLength(config.contextLength);
    setReasoning(config.reasoning);
    setStallSeconds(config.stallSeconds);
    setHistoryChars(config.historyChars);
    setApiToken('');
  }, [open, config]);

  useEffect(() => { if (!open) loaded.current = false; }, [open]);

  /** Ask the server to reach LM Studio; the token never passes through here. */
  const test = useCallback(async () => {
    setTesting(true);
    setResult(null);
    await onSave({ lmStudioUrl: lmStudioUrl.trim(), ...(apiToken ? { apiToken: apiToken.trim() } : {}) });
    try {
      const r = await fetch('/api/models');
      const data = await r.json() as { ok: boolean; models: string[]; error: string | null };
      setTesting(false);
      if (data.ok) {
        setModels(data.models);
        setModel((prev) => (prev && data.models.includes(prev) ? prev : (data.models[0] ?? '')));
        toast.success(data.models.length ? `Connected — ${data.models.length} model(s)` : 'Connected');
        setResult({
          ok: true,
          text: data.models.length
            ? `Connected — ${data.models.length} model(s) available.`
            : 'Connected, but no models are loaded in LM Studio.',
        });
      } else {
        setModels([]);
        toast.error(data.error ?? 'Connection failed', { duration: 8000 });
        setResult({ ok: false, text: data.error ?? 'Connection failed' });
      }
    } catch (err) {
      setTesting(false);
      setResult({ ok: false, text: `Couldn't reach the app server. (${(err as Error).message})` });
    }
  }, [apiToken, lmStudioUrl, onSave]);

  const save = async (): Promise<void> => {
    await onSave({
      lmStudioUrl: lmStudioUrl.trim(),
      model,
      systemPrompt,
      mcpTools: mcpTools.trim(),
      contextLength: contextLength.trim(),
      reasoning,
      stallSeconds: stallSeconds.trim(),
      historyChars: historyChars.trim(),
      ...(apiToken ? { apiToken: apiToken.trim() } : {}),
    });
    setApiToken('');
    onClose();
  };

  const tokenStats = apiToken && (
    <div className={`hint token-stats${/[A-Z]/.test(apiToken) ? '' : ' bad'}`}>
      {apiToken.length} chars &middot; {(apiToken.match(/[A-Z]/g) || []).length} uppercase &middot;{' '}
      {(apiToken.match(/[a-z]/g) || []).length} lowercase
      {!/[A-Z]/.test(apiToken) && ' — no capitals, so this looks case-folded'}
      {apiToken !== apiToken.trim() && ' — has surrounding whitespace'}
    </div>
  );

  const colonWarning = (() => {
    const i = apiToken.indexOf(':');
    if (i < 0) return null;
    const head = apiToken.slice(0, i);
    const tail = apiToken.slice(i + 1);
    if (/[A-Z]/.test(head) || !/[A-Z]/.test(tail)) return null;
    return (
      <div className="hint token-stats bad">
        The part before the colon has no capitals while the part after does.
        iOS lowercases that half when it treats the token as a web address —
        re-copy it as plain text, or fix the capitals by hand.
      </div>
    );
  })();

  return (
    <Drawer.Root open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <Drawer.Portal>
        <Drawer.Overlay className="drawer-overlay" />
        <Drawer.Content className="drawer-content" aria-describedby={undefined}>
          <div className="drawer-handle" />
          <Drawer.Title className="drawer-title">Connection</Drawer.Title>

          {/* Vaul drags the content element to dismiss. If that same element
              is also the scroll container the two gestures fight, so the
              fields scroll in their own region and the actions stay pinned
              where they can always be reached. */}
          <div
            className="drawer-scroll"
            data-vaul-no-drag
            onFocus={(e) => {
              // The last fields sit above a pinned footer and, once the
              // software keyboard opens, below the fold. Bring whichever is
              // focused into the middle of the scroll region so you can see
              // what you are typing.
              const field = (e.target as HTMLElement).closest('.field')
              field?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }}
          >

          <div className="field">
            <label htmlFor="cfg-url">LM Studio address</label>
            <input
              id="cfg-url"
              type="text"
              placeholder="http://127.0.0.1:1234"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              value={lmStudioUrl}
              onChange={(e) => setLmStudioUrl(e.target.value)}
            />
            <div className="hint">
              Where <b>this app&apos;s server</b> reaches LM Studio. They run on the
              same machine, so loopback is right — your phone never contacts
              LM Studio directly.
            </div>
          </div>

          <div className="field">
            <label htmlFor="cfg-model">Model</label>
            <select id="cfg-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.length === 0 && <option value={model}>{model || 'Test connection to load models...'}</option>}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>

          <div className="field">
            <div className="label-row">
              <label htmlFor="cfg-token">API token</label>
              <button
                type="button"
                className="reveal"
                aria-pressed={showToken}
                onClick={() => setShowToken((v) => !v)}
              >
                {showToken
                  ? <><EyeOff size={13} aria-hidden="true" /> hide</>
                  : <><Eye size={13} aria-hidden="true" /> show</>}
              </button>
            </div>
            <input
              id="cfg-token"
              type="text"
              className={`token-input${showToken ? '' : ' masked'}`}
              placeholder={config?.hasToken ? 'saved — type to replace' : 'Required if authentication is on'}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              name="lmstudio-api-token"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
            />
            {colonWarning}
            {tokenStats}
            <div className="hint">
              Stored on the server, not on this device, so every phone works
              without setup. <b>Paste it — don&apos;t type it.</b> Tokens are
              case-sensitive and hand-typing loses the capitals.
            </div>
          </div>

          <h3 className="sheet-h">Prompt template</h3>
          <div className="field">
            <label htmlFor="cfg-system">System prompt</label>
            <textarea
              id="cfg-system"
              rows={4}
              placeholder="e.g. You are a concise, technical assistant."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <div className="hint">Sent at the start of every new chat.</div>
          </div>

          <h3 className="sheet-h">Generation</h3>
          <div className="field">
            <label htmlFor="cfg-reasoning">Default reasoning effort</label>
            <select id="cfg-reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value)}>
              <option value="">
                Auto{modelConfig?.reasoning?.default ? ` — ${modelConfig.reasoning.default}` : ''}
              </option>
              {levelsFor(modelConfig).map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
            <div className="hint">
              Applies to new chats; any chat can override it from the gauge next
              to the message box. These levels come from the selected model&apos;s
              manifest and differ per model.
            </div>
          </div>

          <div className="field">
            <label htmlFor="cfg-stall">Give up after (seconds of silence)</label>
            <input
              id="cfg-stall"
              type="text"
              inputMode="numeric"
              placeholder="180"
              value={stallSeconds}
              onChange={(e) => setStallSeconds(e.target.value)}
            />
            <div className="hint">
              How long the server waits with no output before abandoning a reply.
              The timer resets whenever LM Studio sends something, so a long
              answer never trips it. Blank or 0 waits forever.
            </div>
          </div>

          <div className="field">
            <label htmlFor="cfg-history">Conversation replayed (characters)</label>
            <input
              id="cfg-history"
              type="text"
              inputMode="numeric"
              placeholder="24000"
              value={historyChars}
              onChange={(e) => setHistoryChars(e.target.value)}
            />
            <div className="hint">
              How much of the thread is resent with every message. The server
              replays the conversation each turn rather than relying on
              LM Studio&apos;s <code>previous_response_id</code>, so one failed
              reply can never make the model forget the thread. Past this
              budget, older turns are summarized by the model and the newest
              third stays word for word. <b>0 replays everything</b> — fine for
              a local model, as long as it fits the model&apos;s own context
              window.
            </div>
          </div>

          <div className="field">
            <label htmlFor="cfg-ctx">Context length (optional)</label>
            <input
              id="cfg-ctx"
              type="text"
              inputMode="numeric"
              placeholder="leave blank to use the loaded model's setting"
              value={contextLength}
              onChange={(e) => setContextLength(e.target.value)}
            />
            <div className="hint">
              <b>Leave this blank.</b> Context length is applied when a model is
              loaded, so sending it with every message makes LM Studio load a
              <i> new</i> instance each time.
            </div>
          </div>

          <h3 className="sheet-h">MCP tools</h3>
          <div className="field">
            <label htmlFor="cfg-mcp">Plugin IDs</label>
            <input
              id="cfg-mcp"
              type="text"
              placeholder="mcp/astrology, mcp/deep-research"
              autoCapitalize="off"
              autoCorrect="off"
              value={mcpTools}
              onChange={(e) => setMcpTools(e.target.value)}
            />
            <div className="hint">
              Comma-separated plugin IDs from LM Studio&apos;s <code>mcp.json</code>.
              Requires <b>&quot;Allow calling servers from mcp.json&quot;</b> in Server Settings.
            </div>
          </div>

          </div>

          <div className="drawer-actions">
            {result && (
              <div className={`hint test-result${result.ok ? ' ok' : ' bad'}`} role="status">
                {result.ok
                  ? <Check size={14} aria-hidden="true" />
                  : <CircleAlert size={14} aria-hidden="true" />}
                <span>{result.text}</span>
              </div>
            )}
            <div className="row">
              <button type="button" onClick={() => void test()} disabled={testing}>
                {testing ? 'Testing...' : 'Test connection'}
              </button>
              <button type="button" className="primary" onClick={() => void save()}>Save</button>
            </div>
            <div className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
              Settings are shared by every device, since they live on the server.
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
