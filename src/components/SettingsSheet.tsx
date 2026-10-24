import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { Drawer } from 'vaul';
import { Eye, EyeOff, Check, CircleAlert, LoaderCircle, Square, Volume2 } from 'lucide-react';
import { toast } from 'sonner';
import { levelsFor } from './ReasoningPicker';
import { DEFAULT_REPLY_STYLE, REPLY_FONTS, REPLY_SIZES } from '../lib/replyStyle';
import type { ReplyFont, ReplySize, ReplyStyle } from '../lib/replyStyle';
import type { ModelConfig, ModelLoadState, PublicConfig } from '../types.ts';
import { DEFAULT_SPEED, DEFAULT_VOICE, SPEEDS, VOICES } from '../lib/speech';
import { speaker } from './SpeakButton';

interface SettingsSheetProps {
  open: boolean;
  config: PublicConfig | null;
  modelConfig: ModelConfig | null;
  onSave: (patch: Partial<PublicConfig> & { apiToken?: string }) => Promise<void>;
  onClose: () => void;
  /** Open the Memories screen. */
  onOpenMemories?: () => void;
  /** This device's reply typography -- applied as it's changed, no Save needed. */
  replyStyle?: ReplyStyle;
  onReplyStyleChange?: (style: ReplyStyle) => void;
  /** How the chat model picked last is loading (see server/model-load.ts). */
  modelLoad?: ModelLoadState | null;
  /** Load the chat model again, after a failed load. */
  onLoadModel?: () => void;
}

interface ProbeResult {
  ok: boolean;
  text: string;
}

/** What /api/models answers: every LLM LM Studio has, and which are loaded. */
interface ModelList {
  ok: boolean;
  models: string[];
  loaded?: string[];
  error: string | null;
}

/** Under the model picker: the picked model loading, loaded, or why it couldn't be. */
function ModelLoadNote({ load, onRetry }: { load: ModelLoadState; onRetry?: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const loading = load.state === 'loading';
  // Ticking, as the header does: a big model takes minutes, and a still label reads as stuck.
  useEffect(() => {
    if (!loading) return undefined;
    const tick = (): void => setElapsed(Math.floor((Date.now() - load.startedAt) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [loading, load.startedAt]);

  if (loading) {
    return (
      <div className="hint model-load" role="status">
        <LoaderCircle size={13} className="spin" aria-hidden="true" />
        <span>Loading {load.model}… {elapsed}s</span>
      </div>
    );
  }
  if (load.state === 'ready') {
    return (
      <div className="hint model-load ok" role="status">
        <Check size={13} aria-hidden="true" />
        <span>Loaded</span>
      </div>
    );
  }
  return (
    <div className="hint model-load bad" role="status">
      <CircleAlert size={13} aria-hidden="true" />
      <span>{load.error || "Couldn't load it."}</span>
      {onRetry && <button type="button" className="reveal" onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** The preview's id in the speaker, apart from any reply's. */
const PREVIEW_ID = 'settings-voice-preview';
const VOICE_SAMPLE = "Here's how replies will sound. If this voice suits you, save, and tap the speaker under any reply.";

/**
 * Settings live on the server now, so this edits server state rather than
 * this device's. The API token is write-only: the server reports whether one
 * is set, never what it is.
 */
export default function SettingsSheet({
  open, config, modelConfig, onSave, onClose, onOpenMemories,
  replyStyle = DEFAULT_REPLY_STYLE, onReplyStyleChange, modelLoad = null, onLoadModel,
}: SettingsSheetProps) {
  const [lmStudioUrl, setLmStudioUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [mcpTools, setMcpTools] = useState('');
  const [contextLength, setContextLength] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [stallSeconds, setStallSeconds] = useState('180');
  const [historyChars, setHistoryChars] = useState('24000');
  const [parallel, setParallel] = useState('4');
  const [memoryDefault, setMemoryDefault] = useState<'on' | 'off'>('off');
  const [backgroundModel, setBackgroundModel] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [autoTitle, setAutoTitle] = useState<'on' | 'off'>('on');
  const [speechVoice, setSpeechVoice] = useState(DEFAULT_VOICE);
  const [speechSpeed, setSpeechSpeed] = useState(DEFAULT_SPEED);
  const voicePlayer = useSyncExternalStore(speaker.subscribe, speaker.getState);
  const previewing = voicePlayer.id === PREVIEW_ID && voicePlayer.status !== 'idle';
  const [models, setModels] = useState<string[]>([]);
  /** Of `models`, the ones LM Studio has loaded right now. */
  const [loaded, setLoaded] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [showToken, setShowToken] = useState(false);
  const initialised = useRef(false);

  useEffect(() => {
    if (!open || !config || initialised.current) return;
    initialised.current = true;
    setLmStudioUrl(config.lmStudioUrl);
    setModel(config.model);
    setSystemPrompt(config.systemPrompt);
    setMcpTools(config.mcpTools);
    setContextLength(config.contextLength);
    setReasoning(config.reasoning);
    setStallSeconds(config.stallSeconds);
    setHistoryChars(config.historyChars);
    setParallel(config.parallel ?? '4');
    setMemoryDefault(config.memoryDefault === 'on' ? 'on' : 'off');
    setBackgroundModel(config.backgroundModel ?? '');
    setMaxOutputTokens(config.maxOutputTokens ?? '');
    setAutoTitle(config.autoTitle === 'off' ? 'off' : 'on');
    setSpeechVoice(config.speechVoice || DEFAULT_VOICE);
    setSpeechSpeed(config.speechSpeed || DEFAULT_SPEED);
    setApiToken('');
  }, [open, config]);

  useEffect(() => { if (!open) initialised.current = false; }, [open]);
  // A preview doesn't outlive the sheet.
  useEffect(() => { if (!open && speaker.getState().id === PREVIEW_ID) speaker.stop(); }, [open]);

  /** The server asks LM Studio, with the token it holds; the browser never sees that. */
  const fetchModels = useCallback(async (): Promise<ModelList> => {
    const r = await fetch('/api/models');
    return await r.json() as ModelList;
  }, []);

  // The list is there as soon as the sheet opens, with the saved
  // connection -- not only after "Test connection". Quietly: a server that
  // can't be reached just leaves the saved model as the one choice, and the
  // button below says why on request.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchModels()
      .then((data) => {
        if (!live || !data.ok) return;
        setModels(data.models);
        setLoaded(data.loaded ?? []);
      })
      .catch(() => { /* the saved model stays as the only option */ });
    return () => { live = false; };
  }, [open, fetchModels]);

  /** Ask the server to reach LM Studio; the token never passes through here. */
  const test = useCallback(async () => {
    setTesting(true);
    setResult(null);
    await onSave({ lmStudioUrl: lmStudioUrl.trim(), ...(apiToken ? { apiToken: apiToken.trim() } : {}) });
    try {
      const data = await fetchModels();
      setTesting(false);
      if (data.ok) {
        setModels(data.models);
        setLoaded(data.loaded ?? []);
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
        setLoaded([]);
        toast.error(data.error ?? 'Connection failed', { duration: 8000 });
        setResult({ ok: false, text: data.error ?? 'Connection failed' });
      }
    } catch (err) {
      setTesting(false);
      setResult({ ok: false, text: `Couldn't reach the app server. (${(err as Error).message})` });
    }
  }, [apiToken, lmStudioUrl, onSave, fetchModels]);


  /**
   * Picking a model saves it at once, unlike the other fields: the server
   * starts loading it then, so it's ready by the time you've closed the
   * sheet and typed -- not left to LM Studio to load on the first message.
   */
  const pickModel = (next: string): void => {
    setModel(next);
    if (next && next !== config?.model) void onSave({ model: next });
  };

  /** "qwen (loaded)": what can answer right now, vs. what LM Studio would load first. */
  // A load that finished while the sheet was open makes its "(loaded)" true too.
  const modelLabel = (m: string): string =>
    (loaded.includes(m) || (modelLoad?.state === 'ready' && modelLoad.model === m) ? `${m} (loaded)` : m);

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
      parallel: parallel.trim(),
      memoryDefault,
      backgroundModel: backgroundModel.trim(),
      maxOutputTokens: maxOutputTokens.trim(),
      autoTitle,
      speechVoice,
      speechSpeed,
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
          <Drawer.Title className="drawer-title">Settings</Drawer.Title>

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
            <h3 className="sheet-h first">Connection</h3>

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
            <select id="cfg-model" value={model} onChange={(e) => pickModel(e.target.value)}>
              {models.length === 0 && <option value={model}>{model || 'No models listed yet -- test the connection'}</option>}
              {/* A saved choice LM Studio no longer lists stays selectable rather than silently changing. */}
              {models.length > 0 && model && !models.includes(model) && <option value={model}>{model} (not in LM Studio's list)</option>}
              {models.map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}
            </select>
            <div className="hint">
              Every LLM LM Studio has downloaded; the ones marked <b>(loaded)</b> answer at once, any other is
              loaded as soon as you pick it.
            </div>
            {modelLoad && modelLoad.model === model && <ModelLoadNote load={modelLoad} onRetry={onLoadModel} />}
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

          <h3 className="sheet-h">Reply text (this device)</h3>
          <div className="field">
            <label htmlFor="cfg-reply-font">Font</label>
            <select
              id="cfg-reply-font"
              value={replyStyle.font}
              onChange={(e) => onReplyStyleChange?.({ ...replyStyle, font: e.target.value as ReplyFont })}
            >
              {REPLY_FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cfg-reply-size">Size</label>
            <select
              id="cfg-reply-size"
              value={replyStyle.size}
              onChange={(e) => onReplyStyleChange?.({ ...replyStyle, size: e.target.value as ReplySize })}
            >
              {REPLY_SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <div className="hint">
              Applies at once and is kept on this device only, unlike the settings below. Thinking blocks and
              tool cards keep their own fonts.
            </div>
          </div>

          <h3 className="sheet-h">Voice</h3>
          <div className="field">
            <label htmlFor="cfg-voice">Read replies aloud in</label>
            <div className="voice-row">
              <select id="cfg-voice" value={speechVoice} onChange={(e) => setSpeechVoice(e.target.value)}>
                {[...new Set(VOICES.map((v) => v.group))].map((group) => (
                  <optgroup key={group} label={group}>
                    {VOICES.filter((v) => v.group === group).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                className="voice-preview"
                aria-label={previewing ? 'Stop the preview' : 'Hear this voice'}
                onClick={() => (previewing ? speaker.stop() : void speaker.speak(PREVIEW_ID, VOICE_SAMPLE, { voice: speechVoice, speed: speechSpeed }))}
              >
                {previewing ? <Square size={12} fill="currentColor" aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
                {previewing ? 'Stop' : 'Hear it'}
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="cfg-voice-speed">Speed</label>
            <select id="cfg-voice-speed" value={speechSpeed} onChange={(e) => setSpeechSpeed(e.target.value)}>
              {SPEEDS.map((v) => <option key={v} value={v}>{v === '1' ? 'Normal' : `${v}×`}</option>)}
            </select>
            <div className="hint">
              The speaker under each reply reads it aloud. The voice is Kokoro, running on the Mac, so nothing leaves it;
              code blocks are mentioned rather than read out.
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
            <label htmlFor="cfg-max-out">Reply length cap (tokens)</label>
            <input
              id="cfg-max-out"
              type="text"
              inputMode="numeric"
              placeholder="no cap"
              value={maxOutputTokens}
              onChange={(e) => setMaxOutputTokens(e.target.value)}
            />
            <div className="hint">
              LM Studio stops a reply at this many tokens, reasoning included.
              At ~20 tokens a second, 4000 is about three minutes of writing;
              without a cap a runaway answer can hold the model for half an
              hour. A cut-off reply says so in its footer. Blank means no cap.
            </div>
          </div>

          <div className="field">
            <label htmlFor="cfg-parallel">Parallel replies</label>
            <input
              id="cfg-parallel"
              type="text"
              inputMode="numeric"
              placeholder="4"
              value={parallel}
              onChange={(e) => setParallel(e.target.value)}
            />
            <div className="hint">
              How many chats can be answered at once. Set it to the model&apos;s
              <b> Parallel</b> value in LM Studio; further messages wait in the
              app and show as queued, and summaries of long threads only run
              when no chat is waiting. 0 sends everything straight to LM Studio.
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

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={autoTitle === 'on'}
              onChange={(e) => setAutoTitle(e.target.checked ? 'on' : 'off')}
            />
            Name chats automatically
          </label>
          <div className="hint" style={{ marginTop: -4 }}>
            After a chat&apos;s first reply, the model writes it a short title from what was actually said, using the
            background model below. A title you type yourself is never replaced.
          </div>

          <div className="field">
            <label htmlFor="cfg-background-model">Background model</label>
            <select id="cfg-background-model" value={backgroundModel} onChange={(e) => setBackgroundModel(e.target.value)}>
              <option value="">Same as the chat model</option>
              {backgroundModel && !models.includes(backgroundModel) && <option value={backgroundModel}>{backgroundModel}</option>}
              {models.filter((m) => m !== model).map((m) => <option key={m} value={m}>{modelLabel(m)}</option>)}
            </select>
            <div className="hint">
              Summarizes long threads, which no one is waiting on. A small,
              fast model here (a mixture-of-experts build, say) does that in
              seconds and leaves the chat model to the chats. It must already be
              loaded in LM Studio, or it is loaded on first use.
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
              This is the default; a folder can set its own list, and any chat can pick its own tools from the{' '}
              <b>Tools</b> button by the message box. Every tool the model is shown costs ~500 prompt tokens a turn.
            </div>
          </div>

          <h3 className="sheet-h">Memory</h3>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={memoryDefault === 'on'}
              onChange={(e) => setMemoryDefault(e.target.checked ? 'on' : 'off')}
            />
            Use memory in chats by default
          </label>
          <div className="hint">
            With memory on, the model can save what it learns about you and sees what it saved before, in every
            chat that has it on. Each chat can switch it with the brain button by the message box. Needs the{' '}
            <code>lm-chat-memory</code> server in LM Studio&apos;s <code>mcp.json</code> -- this app&apos;s own pool,
            separate from what LM Studio&apos;s chat window remembers.
          </div>
          {onOpenMemories && (
            <div className="row">
              <button type="button" onClick={onOpenMemories}>Memories…</button>
            </div>
          )}

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
