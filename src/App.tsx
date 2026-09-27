import { useState, useEffect } from 'react';
import { Toaster } from 'sonner';
import Header from './components/Header';
import ChatThread from './components/ChatThread';
import Composer from './components/Composer';
import SettingsSheet from './components/SettingsSheet';
import ConversationList from './components/ConversationList';
import ReasoningPicker, { labelFor } from './components/ReasoningPicker';
import useServerState from './hooks/useServerState';
import useModelConfig from './hooks/useModelConfig';
import useWakeLock from './hooks/useWakeLock';
import './App.css';

export default function App() {
  const server = useServerState();
  const {
    conversations, activeId, active, config, status, startedAt, busy, working,
    send, stop, newChat, openChat, deleteChat, renameChat, setReasoning, saveConfig,
  } = server;

  const modelConfig = useModelConfig(config?.model);
  // A courtesy now rather than load-bearing: the turn survives a locked
  // screen regardless, since the server owns it. Any chat replying counts.
  useWakeLock(Object.keys(working).length > 0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);

  // Nothing to talk to yet: get the server configured first.
  useEffect(() => {
    if (config && !config.model) setSettingsOpen(true);
  }, [config]);

  const messages = active?.messages ?? [];
  const reasoning = active?.reasoning ?? null;

  return (
    <div className="app">
      <Toaster position="top-center" theme="dark" toastOptions={{ className: 'lm-chat-toast' }} />
      <Header
        status={status}
        startedAt={startedAt}
        onNewChat={() => void newChat()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenChats={() => setChatsOpen(true)}
      />
      {/* Keyed by thread: switching mounts a fresh one, rather than animating
          one thread's messages out while the other's animate in. */}
      <ChatThread key={activeId ?? 'none'} messages={messages} summary={active?.summary} />
      <Composer
        onSend={(text) => void send(text)}
        disabled={busy}
        busy={busy}
        onStop={() => void stop()}
        reasoningLabel={labelFor(reasoning, config?.reasoning)}
        onOpenReasoning={() => setReasoningOpen(true)}
      />
      <ReasoningPicker
        open={reasoningOpen}
        value={reasoning}
        defaultValue={config?.reasoning}
        config={modelConfig}
        onChange={(v) => void setReasoning(v)}
        onClose={() => setReasoningOpen(false)}
      />
      <ConversationList
        open={chatsOpen}
        conversations={conversations}
        activeId={activeId}
        working={working}
        onOpen={(id) => void openChat(id)}
        onDelete={(id) => void deleteChat(id)}
        onRename={(id, name) => void renameChat(id, name)}
        onClose={() => setChatsOpen(false)}
      />
      <SettingsSheet
        open={settingsOpen}
        config={config}
        modelConfig={modelConfig}
        onSave={saveConfig}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
